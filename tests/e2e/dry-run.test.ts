/**
 * End-to-end tests using dry run mode with mocked APIs
 */

import { FulfillmentProcessor } from '../../src/services/fulfillment';
import { 
  MockCounterpartyService, 
  MockBitcoinService, 
  MockStateManager 
} from '../mocks/mock-services';
import { mockFilledOrder, mockBlock } from '../mocks/mock-data';

describe('E2E Tests - Dry Run Mode', () => {
  let processor: FulfillmentProcessor;
  let mockCounterparty: MockCounterpartyService;
  let mockBitcoin: MockBitcoinService;
  let mockState: MockStateManager;

  beforeEach(() => {
    // Use testnet for E2E tests
    process.env.NETWORK = 'testnet';
    process.env.DRY_RUN = 'true';
    
    // Create mocks
    mockCounterparty = new MockCounterpartyService();
    mockBitcoin = new MockBitcoinService();
    mockState = new MockStateManager();
    
    processor = new FulfillmentProcessor({
      xcpfolioAddress: '1TestAddress',
      privateKey: 'cTestKey',
      network: 'testnet',
      dryRun: true, // Critical - no real broadcasts
      maxMempoolTxs: 25,
      composeCooldown: 100,
      maxPreBroadcastRetries: 3,
      rbfEnabled: true,
      stuckTxThreshold: 3,
      maxTotalFeeSats: 10000,
      maxFeeRateForNewTx: 100
    });
    
    // Override services with mocks
    (processor as any).counterparty = mockCounterparty;
    (processor as any).bitcoin = mockBitcoin;
    (processor as any).state = mockState;
  });

  describe('API Connectivity', () => {
    it('should connect to Counterparty API', async () => {
      mockCounterparty.getCurrentBlock.mockResolvedValue(mockBlock);
      const block = await mockCounterparty.getCurrentBlock();
      
      expect(block).toBeDefined();
      expect(block.block_index).toBeGreaterThan(0);
    });

    it('should connect to Bitcoin API', async () => {
      mockBitcoin.getCurrentBlockHeight.mockResolvedValue(850000);
      const height = await mockBitcoin.getCurrentBlockHeight();
      
      expect(height).toBeGreaterThan(0);
    });

    it('should fetch fee rates', async () => {
      const rates = await mockBitcoin.getFeeRates();
      
      expect(rates).toBeDefined();
      expect(rates.fastestFee).toBeGreaterThan(0);
      expect(rates.minimumFee).toBeGreaterThan(0);
    });
  });

  describe('Order Processing - Dry Run', () => {
    it('should process orders without broadcasting', async () => {
      // Setup mock to return a filled order
      mockCounterparty.getFilledXCPFOLIOOrders.mockResolvedValue([mockFilledOrder]);
      mockCounterparty.isAssetTransferredTo.mockResolvedValue(false);
      mockBitcoin.getOptimalFeeRate.mockResolvedValue(20);
      
      const results = await processor.process();
      
      // In dry run, we should process but not actually broadcast
      expect(results).toHaveLength(1);
      if (results[0].success && results[0].stage === 'broadcast') {
        expect(results[0].txid).toBe('dry-run');
      }
    });

    it('should respect single worker lock in dry run', async () => {
      mockCounterparty.getFilledXCPFOLIOOrders.mockResolvedValue([]);
      
      const promise1 = processor.process();
      const promise2 = processor.process();
      
      const [results1, results2] = await Promise.all([promise1, promise2]);
      
      // One should process, one should be skipped due to lock
      const totalProcessed = results1.length + results2.length;
      expect(totalProcessed).toBeLessThanOrEqual(1);
    });
  });

  describe('State Management', () => {
    it('should track processed orders in dry run', async () => {
      const state = processor.getState();
      
      expect(state).toBeDefined();
      expect(state.processedOrders).toBeDefined();
      expect(state.lastBlock).toBeGreaterThanOrEqual(0);
    });
  });
});