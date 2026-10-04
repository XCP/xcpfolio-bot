import { FulfillmentProcessor } from '../../src/services/fulfillment';
import { CounterpartyService } from '../../src/services/counterparty';
import { BitcoinService } from '../../src/services/bitcoin';
import { StateManager } from '../../src/services/state';
import { OrderHistoryService } from '../../src/services/order-history';
import { NotificationService } from '../../src/services/notifications';
import { mockFilledOrder } from '../mocks/mock-data';

jest.mock('../../src/services/counterparty');
jest.mock('../../src/services/bitcoin');
jest.mock('../../src/services/state');
jest.mock('../../src/services/order-history');
jest.mock('../../src/services/notifications');

describe('Fulfillment recovery after a buyer transfers an asset onward', () => {
  const seller = 'seller';
  const buyer = 'buyer';
  const order = { ...mockFilledOrder, source: seller, block_index: 100 };
  const delivered = {
    tx_hash: 'original-delivery',
    block_index: 202,
    block_time: 1700000200,
    source: seller,
    issuer: buyer,
    transfer: true,
    status: 'valid',
  };
  let processed: Set<string>;
  let issuances: any[];
  let watches: Record<string, { txid: string; blockHeight?: number; blockHash?: string }>;

  function createProcessor() {
    const processor = new FulfillmentProcessor({ xcpfolioAddress: seller, privateKey: 'unused' });
    const counterparty = jest.mocked((CounterpartyService as jest.Mock).mock.instances.at(-1));
    const bitcoin = jest.mocked((BitcoinService as jest.Mock).mock.instances.at(-1));
    const state = jest.mocked((StateManager as jest.Mock).mock.instances.at(-1));
    const history = jest.mocked((OrderHistoryService as jest.Mock).mock.instances.at(-1));

    bitcoin.getUnconfirmedTxCount.mockResolvedValue(0);
    bitcoin.getCurrentBlockHeight.mockResolvedValue(300);
    bitcoin.getCanonicalBlockHash.mockResolvedValue('a'.repeat(64));
    bitcoin.getConfirmationStatus.mockResolvedValue({ confirmed: true, block_height: 202, block_hash: 'a'.repeat(64) });
    counterparty.getCurrentBlock.mockResolvedValue({ block_index: 300, block_hash: 'a'.repeat(64) });
    counterparty.getMempoolTransfers.mockResolvedValue([]);
    counterparty.getMempoolBuyOrders.mockResolvedValue([]);
    counterparty.getFilledXCPFOLIOOrders.mockResolvedValue([order]);
    counterparty.getAssetInfo.mockResolvedValue({ owner: 'later-owner' });
    counterparty.getAssetIssuances.mockImplementation(async () => issuances);
    counterparty.getOrderMatches.mockResolvedValue([{
      tx0_address: seller, tx1_address: buyer, tx1_hash: 'buy-order', block_index: 200,
    }]);
    state.getLastCleanup.mockResolvedValue(300);
    state.getProcessedOrders.mockImplementation(async () => new Set(processed));
    state.isOrderProcessed.mockImplementation(async (hash: string) => processed.has(hash));
    state.markOrderProcessed.mockImplementation(async (hash: string) => { processed.add(hash); });
    state.getDeliveryWatches.mockImplementation(async () => ({ ...watches }));
    state.watchDelivery.mockImplementation(async (hash: string, watch: any) => { watches[hash] = watch; });
    state.finishDeliveryWatch.mockImplementation(async (hash: string, reopen: boolean) => {
      delete watches[hash];
      if (reopen) processed.delete(hash);
    });
    history.getOrders.mockResolvedValue([]);
    history.getOrder.mockResolvedValue({ purchasedAt: 1700000000000 });

    // Keep all transaction execution and delays outside these loop-level tests.
    const attempt = jest.spyOn(processor as any, 'processOrderSafely').mockResolvedValue({
      orderHash: order.tx_hash, asset: 'RAREPEPE', buyer,
      success: false, stage: 'validation', error: 'Not owned',
    });
    jest.spyOn(processor as any, 'sleep').mockResolvedValue(undefined);
    return { processor, state, history, attempt, counterparty, bitcoin };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    processed = new Set();
    watches = {};
    issuances = [
      { ...delivered, tx_hash: 'onward-transfer', source: buyer, issuer: 'later-owner', block_index: 210 },
      delivered,
    ];
  });

  afterEach(() => jest.restoreAllMocks());

  it.each(['missing', 'orphaned'])("reopens a persisted %s delivery after a restart", async reason => {
    processed.add(order.tx_hash);
    watches[order.tx_hash] = { txid: 'delivery', blockHeight: 299, blockHash: 'b'.repeat(64) };
    const run = createProcessor();
    run.counterparty.getAssetInfo.mockResolvedValue({ owner: seller });
    run.bitcoin.getConfirmationStatus.mockResolvedValue(reason === 'missing' ? null : {
      confirmed: true, block_height: 299, block_hash: 'b'.repeat(64),
    });
    await run.processor.process();
    expect(run.history.recordDeliveryConfirmation).toHaveBeenCalledWith(order.tx_hash);
    expect(run.state.finishDeliveryWatch).toHaveBeenCalledWith(order.tx_hash, true);
    expect(run.attempt).toHaveBeenCalledTimes(1);
  });

  it('keeps a delivery processed while it is back in the mempool', async () => {
    processed.add(order.tx_hash);
    watches[order.tx_hash] = { txid: 'delivery', blockHeight: 299, blockHash: 'b'.repeat(64) };
    const run = createProcessor();
    run.bitcoin.getConfirmationStatus.mockResolvedValue({ confirmed: false });
    await run.processor.process();
    expect(processed.has(order.tx_hash)).toBe(true);
    expect(run.attempt).not.toHaveBeenCalled();
    expect(watches[order.tx_hash]).toEqual({ txid: 'delivery' });
  });

  it('does not reopen deliveries or execute orders during an upstream outage', async () => {
    processed.add(order.tx_hash);
    watches[order.tx_hash] = { txid: 'delivery' };
    const run = createProcessor();
    run.bitcoin.getConfirmationStatus.mockRejectedValue(new Error('503 unavailable'));
    await expect(run.processor.process()).rejects.toThrow('503 unavailable');
    expect(processed.has(order.tx_hash)).toBe(true);
    expect(run.state.finishDeliveryWatch).not.toHaveBeenCalled();
    expect(run.attempt).not.toHaveBeenCalled();
  });

  it('waits while Counterparty is on an orphaned branch', async () => {
    const run = createProcessor();
    run.counterparty.getCurrentBlock.mockResolvedValue({ block_index: 300, block_hash: 'b'.repeat(64) });
    await run.processor.process();
    expect(run.state.getDeliveryWatches).not.toHaveBeenCalled();
    expect(run.attempt).not.toHaveBeenCalled();
  });

  it('recovers the original delivery and stays complete across fresh cron processors', async () => {
    const first = createProcessor();
    expect(await first.processor.process()).toEqual([]);
    expect(first.attempt).not.toHaveBeenCalled();
    expect(first.state.markOrderProcessed).toHaveBeenCalledWith(order.tx_hash);
    expect(first.history.upsertOrder).toHaveBeenCalledWith(expect.objectContaining({
      status: 'confirmed', stage: 'confirmed', buyer,
      txid: 'original-delivery', confirmedBlock: 202,
      deliveredAt: 1700000200000, purchasedAt: 1700000000000,
    }));

    const next = createProcessor();
    expect(await next.processor.process()).toEqual([]);
    expect(next.attempt).not.toHaveBeenCalled();
    expect(next.counterparty.getAssetIssuances).not.toHaveBeenCalled();
    expect(NotificationService.sendOnce).not.toHaveBeenCalled();
    expect(NotificationService.info).not.toHaveBeenCalled();
  });

  it.each([
    ['no delivery', []],
    ['another buyer', [{ ...delivered, issuer: 'someone-else' }]],
    ['another sender', [{ ...delivered, source: 'someone-else' }]],
    ['an earlier sale before this match', [{ ...delivered, block_index: 150 }]],
    ['an invalid transfer', [{ ...delivered, status: 'invalid' }]],
    ['a non-transfer issuance', [{ ...delivered, transfer: false }]],
  ])('does not mark an order complete based on %s', async (_label, history) => {
    issuances = history;
    const run = createProcessor();
    await run.processor.process();
    expect(run.attempt).toHaveBeenCalled();
    expect(run.state.markOrderProcessed).not.toHaveBeenCalled();
  });

  it('does not infer delivery when the history lookup fails', async () => {
    const run = createProcessor();
    run.counterparty.getAssetIssuances.mockRejectedValue(new Error('API unavailable'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await run.processor.process();
    expect(run.state.markOrderProcessed).not.toHaveBeenCalled();
    expect(run.attempt).toHaveBeenCalled();
  });

  it('still recovers an order when the buyer currently owns the asset', async () => {
    const run = createProcessor();
    run.counterparty.getAssetInfo.mockResolvedValue({ owner: buyer });
    await run.processor.process();
    expect(run.state.markOrderProcessed).toHaveBeenCalledWith(order.tx_hash);
    expect(run.attempt).not.toHaveBeenCalled();
  });

  it('does not reuse an old delivery when the bot owns the asset again', async () => {
    const run = createProcessor();
    run.counterparty.getAssetInfo.mockResolvedValue({ owner: seller });
    await run.processor.process();
    expect(run.counterparty.getAssetIssuances).not.toHaveBeenCalled();
    expect(run.state.markOrderProcessed).not.toHaveBeenCalled();
    expect(run.attempt).toHaveBeenCalled();
  });

  it('keeps retry attempts in logs without sending processing notifications', async () => {
    issuances = [];
    for (let i = 0; i < 3; i++) {
      const run = createProcessor();
      await run.processor.process();
      expect(run.attempt).toHaveBeenCalledTimes(1);
    }
    expect(NotificationService.info).not.toHaveBeenCalled();
  });
});
