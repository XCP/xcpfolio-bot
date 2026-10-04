import { Redis } from '@upstash/redis';
import { StateManager } from '../../src/services/state';

jest.mock('@upstash/redis');

describe('fulfillment state during Redis failures', () => {
  const originalUrl = process.env.KV_REST_API_URL;
  const originalToken = process.env.KV_REST_API_TOKEN;
  const initial = () => ({ lastBlock: 100, lastOrderHash: null, lastChecked: 0, lastCleanup: 100,
    processedOrders: ['paid'], failedOrders: [], deliveryWatches: { paid: { txid: 'delivery' } },
    deliveryRetries: ['retry'] });
  let stored: ReturnType<typeof initial>;
  const get = jest.fn();
  const set = jest.fn();
  beforeEach(() => {
    jest.useFakeTimers();
    process.env.KV_REST_API_URL = 'https://redis.invalid';
    process.env.KV_REST_API_TOKEN = 'test-only';
    stored = initial();
    get.mockReset().mockImplementation(async () => structuredClone(stored));
    set.mockReset().mockImplementation(async (_key, value) => { stored = JSON.parse(value); return 'OK'; });
    (Redis as unknown as jest.Mock).mockImplementation(() => ({ get, set }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers(); jest.restoreAllMocks();
    if (originalUrl === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = originalUrl;
    if (originalToken === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = originalToken;
  });

  it.each([false, true])('never replaces unread state with defaults (cached=%s)', async cached => {
    const manager = new StateManager();
    if (cached) { await manager.getState(); jest.advanceTimersByTime(6000); }
    get.mockRejectedValueOnce(new Error('timeout'));
    await expect(manager.setLastBlock(101)).rejects.toThrow('timeout');
    expect(set).not.toHaveBeenCalled(); expect(stored).toEqual(initial());
    await manager.setLastBlock(101);
    expect(stored).toEqual({ ...initial(), lastBlock: 101, lastChecked: Date.now() });
    expect(await new StateManager().getDeliveryRetries()).toEqual(['retry']);
  });

  it.each([false, true])('reloads durable state after an ambiguous write (committed=%s)', async committed => {
    const manager = new StateManager();
    set.mockImplementationOnce(async (_key, value) => {
      if (committed) stored = JSON.parse(value);
      throw new Error('response lost');
    });
    await expect(manager.finishDeliveryWatch('paid', true)).rejects.toThrow('response lost');
    await manager.finishDeliveryWatch('paid', true);
    expect(get).toHaveBeenCalledTimes(2);
    expect(stored.processedOrders).toEqual([]);
    expect(stored.deliveryRetries).toEqual(['retry', 'paid']);
    expect(await new StateManager().getDeliveryWatches()).toEqual({});
  });

  it('initializes a genuinely absent key', async () => {
    get.mockResolvedValueOnce(null);
    await new StateManager().setLastBlock(101);
    expect(stored).toMatchObject({lastBlock:101,processedOrders:[],failedOrders:[]});
  });
});
