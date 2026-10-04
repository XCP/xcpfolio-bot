import { Redis } from '@upstash/redis';
import { FulfillmentProcessor } from '../../src/services/fulfillment';
import { CounterpartyService } from '../../src/services/counterparty';
import { BitcoinService } from '../../src/services/bitcoin';
import { StateManager, FulfillmentState } from '../../src/services/state';
import { OrderHistoryService } from '../../src/services/order-history';
import { mockFilledOrder } from '../mocks/mock-data';

jest.mock('@upstash/redis');
jest.mock('../../src/services/counterparty');
jest.mock('../../src/services/bitcoin');
jest.mock('../../src/services/order-history');
jest.mock('../../src/services/notifications');

describe('Durable delivery retries', () => {
  const seller = 'seller';
  const order = { ...mockFilledOrder, source: seller, block_index: 100 };
  const newer = Array.from({ length: 10 }, (_, i) => ({
    ...order, tx_hash: `newer-${i}`, block_index: 299,
  }));
  let stored: string;
  const read = (): FulfillmentState => JSON.parse(stored);
  const originalUrl = process.env.KV_REST_API_URL;
  const originalToken = process.env.KV_REST_API_TOKEN;

  function start() {
    const processor = new FulfillmentProcessor({ xcpfolioAddress: seller, privateKey: 'unused' });
    const counterparty = jest.mocked((CounterpartyService as jest.Mock).mock.instances.at(-1));
    const bitcoin = jest.mocked((BitcoinService as jest.Mock).mock.instances.at(-1));
    const history = jest.mocked((OrderHistoryService as jest.Mock).mock.instances.at(-1));
    bitcoin.getUnconfirmedTxCount.mockResolvedValue(0);
    bitcoin.getCurrentBlockHeight.mockResolvedValue(300);
    bitcoin.getCanonicalBlockHash.mockResolvedValue('a'.repeat(64));
    bitcoin.getConfirmationStatus.mockResolvedValue({
      confirmed: true, block_height: 299, block_hash: 'b'.repeat(64),
    });
    counterparty.getCurrentBlock.mockResolvedValue({ block_index: 300, block_hash: 'a'.repeat(64) });
    counterparty.getMempoolTransfers.mockResolvedValue([]);
    counterparty.getMempoolBuyOrders.mockResolvedValue([]);
    counterparty.getFilledXCPFOLIOOrders.mockResolvedValue([...newer, order]);
    counterparty.getAssetInfo.mockResolvedValue({ owner: seller });
    counterparty.getOrderMatches.mockResolvedValue([{
      tx0_address: seller, tx1_address: 'buyer', tx1_hash: 'buy-order', block_index: 200,
    }]);
    history.getOrders.mockResolvedValue([]);
    // Exercise the real loop and StateManager; never sign or broadcast in tests.
    const attempt = jest.spyOn(processor as any, 'processOrderSafely').mockResolvedValue({
      orderHash: order.tx_hash, asset: 'RAREPEPE', buyer: 'buyer',
      success: false, stage: 'compose', error: 'Temporary composition failure',
    });
    jest.spyOn(processor as any, 'sleep').mockResolvedValue(undefined);
    return { processor, counterparty, bitcoin, attempt };
  }

  beforeEach(() => {
    process.env.KV_REST_API_URL = 'https://redis.invalid';
    process.env.KV_REST_API_TOKEN = 'test-only';
    stored = JSON.stringify({
      lastBlock: 300, lastOrderHash: null, lastChecked: 0, lastCleanup: 300,
      processedOrders: [order.tx_hash, ...newer.map(o => o.tx_hash)], failedOrders: [],
      deliveryWatches: { [order.tx_hash]: { txid: 'orphaned-delivery', blockHeight: 299, blockHash: 'b'.repeat(64) } },
    });
    // Real serialization: new StateManagers cannot read the old instance's cache.
    (Redis as unknown as jest.Mock).mockImplementation(() => ({
      get: jest.fn(async () => read()),
      set: jest.fn(async (_key: string, value: string) => { stored = value; return 'OK'; }),
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = originalUrl;
    if (originalToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = originalToken;
  });

  it.each(['missing', 'orphaned'])('retries a %s delivery behind ten completed orders after a restart', async reason => {
    const first = start();
    if (reason === 'missing') first.bitcoin.getConfirmationStatus.mockResolvedValue(null);
    // Recheck runs, but this invocation ends before the first retry attempt.
    first.processor.requestStop();
    await first.processor.process();
    expect(first.attempt).not.toHaveBeenCalled();
    expect(read().processedOrders).not.toContain(order.tx_hash);
    expect(read().deliveryWatches).toEqual({});
    expect(read().deliveryRetries).toEqual([order.tx_hash]);

    const restarted = start();
    await restarted.processor.process();
    expect(restarted.attempt).toHaveBeenCalledTimes(1);
    expect(restarted.attempt).toHaveBeenCalledWith(order, 300);
    // A failed attempt does not consume the queue; another restart retries it.
    expect(read().deliveryRetries).toEqual([order.tx_hash]);
    const next = start();
    await next.processor.process();
    expect(next.attempt).toHaveBeenCalledTimes(1);
  });

  it('retries in the same pass and does not attempt a queued order twice', async () => {
    const run = start();
    run.counterparty.getFilledXCPFOLIOOrders.mockResolvedValue([order, ...newer]);
    await run.processor.process();
    expect(run.attempt).toHaveBeenCalledTimes(1);
  });

  it('keeps the retry when a canonical filled order is absent, then retries when it returns', async () => {
    const first = start();
    first.counterparty.getFilledXCPFOLIOOrders.mockResolvedValue(newer);
    await first.processor.process();
    expect(first.attempt).not.toHaveBeenCalled();
    expect(read().deliveryRetries).toEqual([order.tx_hash]);
    const next = start();
    await next.processor.process();
    expect(next.attempt).toHaveBeenCalledWith(order, 300);
  });

  it('retains retries through capacity limits and processed-marker cleanup', async () => {
    const state = new StateManager();
    await state.finishDeliveryWatch(order.tx_hash, true);
    await state.finishDeliveryWatch(order.tx_hash, true);
    await state.clearOldOrders(1);
    expect(await new StateManager().getDeliveryRetries()).toEqual([order.tx_hash]);
    const run = start();
    run.bitcoin.getUnconfirmedTxCount.mockResolvedValue(25);
    await run.processor.process();
    expect(run.attempt).not.toHaveBeenCalled();
    expect(read().deliveryRetries).toEqual([order.tx_hash]);
  });

  it('does not consume a retry on a source outage', async () => {
    await new StateManager().finishDeliveryWatch(order.tx_hash, true);
    const run = start();
    run.counterparty.getFilledXCPFOLIOOrders.mockRejectedValue(new Error('upstream unavailable'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(run.processor.process()).rejects.toThrow('upstream unavailable');
    expect(run.attempt).not.toHaveBeenCalled();
    expect(read().deliveryRetries).toEqual([order.tx_hash]);
  });

  it('hands recovery over to the replacement watch before removing the retry', async () => {
    const state = new StateManager();
    await state.finishDeliveryWatch(order.tx_hash, true);
    await state.watchDelivery(order.tx_hash, { txid: 'replacement' });
    expect(await new StateManager().getDeliveryRetries()).toEqual([order.tx_hash]);
    await state.markOrderProcessed(order.tx_hash);
    const persisted = new StateManager();
    expect(await persisted.getDeliveryRetries()).toEqual([]);
    expect(await persisted.getDeliveryWatches()).toEqual({ [order.tx_hash]: { txid: 'replacement' } });
    const next = start();
    next.bitcoin.getConfirmationStatus.mockResolvedValue({ confirmed: false });
    await next.processor.process();
    expect(next.attempt).not.toHaveBeenCalled();
  });

  it('keeps the existing early stop for ordinary historical orders', async () => {
    const state = read();
    state.deliveryWatches = {};
    state.processedOrders = newer.map(o => o.tx_hash);
    stored = JSON.stringify(state); // Legacy state without a retry queue.
    const run = start();
    await run.processor.process();
    expect(run.attempt).not.toHaveBeenCalled();
    expect(await new StateManager().getDeliveryRetries()).toEqual([]);
  });
});
