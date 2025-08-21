/**
 * Integration tests for FulfillmentProcessor
 */

import { FulfillmentProcessor } from '../../src/services/fulfillment';
import { 
  MockCounterpartyService, 
  MockBitcoinService, 
  MockStateManager 
} from '../mocks/mock-services';
import { mockFilledOrder, mockPendingOrder, mockUTXO } from '../mocks/mock-data';

describe('FulfillmentProcessor Integration', () => {
  let processor: FulfillmentProcessor;
  let mockCounterparty: MockCounterpartyService;
  let mockBitcoin: MockBitcoinService;
  let mockState: MockStateManager;

  beforeEach(() => {
    // Create mocks
    mockCounterparty = new MockCounterpartyService();
    mockBitcoin = new MockBitcoinService();
    mockState = new MockStateManager();

    // Create processor with dependency injection would be ideal
    // For now, we'll test with real processor and mock the services
    processor = new FulfillmentProcessor({
      xcpfolioAddress: '1TestAddressDoNotUse',
      privateKey: 'cTestPrivateKeyDoNotUse',
      network: 'testnet',
      dryRun: false,
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

  describe('Order Processing', () => {
    it('should process a valid filled order', async () => {
      mockCounterparty.getFilledXCPFOLIOOrders.mockResolvedValue([mockFilledOrder]);
      mockCounterparty.isAssetTransferredTo.mockResolvedValue(false);
      mockBitcoin.getOptimalFeeRate.mockResolvedValue(20);

      const results = await processor.process();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].asset).toBe('RAREPEPE');
      expect(results[0].txid).toBe('broadcast_tx_12345');

      // Verify the flow
      expect(mockCounterparty.validateOrder).toHaveBeenCalled();
      expect(mockCounterparty.isAssetTransferredTo).toHaveBeenCalled();
      expect(mockCounterparty.composeTransfer).toHaveBeenCalled();
      expect(mockBitcoin.signTransaction).toHaveBeenCalled();
      expect(mockBitcoin.broadcastTransaction).toHaveBeenCalled();
      expect(mockState.markOrderProcessed).toHaveBeenCalledWith('order_tx_hash_12345');
    });

    it('should skip already transferred assets', async () => {
      mockCounterparty.getFilledXCPFOLIOOrders.mockResolvedValue([mockFilledOrder]);
      mockCounterparty.isAssetTransferredTo.mockResolvedValue(true);

      const results = await processor.process();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].stage).toBe('confirmed');

      // Should not attempt to create new transaction
      expect(mockCounterparty.composeTransfer).not.toHaveBeenCalled();
      expect(mockBitcoin.signTransaction).not.toHaveBeenCalled();
    });

    it('should skip already processed orders', async () => {
      mockCounterparty.getFilledXCPFOLIOOrders.mockResolvedValue([mockFilledOrder]);
      mockState.isOrderProcessed.mockReturnValue(true);

      const results = await processor.process();

      expect(results).toHaveLength(0);
      expect(mockCounterparty.composeTransfer).not.toHaveBeenCalled();
    });

    it('should handle validation failures', async () => {
      mockCounterparty.getFilledXCPFOLIOOrders.mockResolvedValue([mockFilledOrder]);
      mockCounterparty.validateOrder.mockResolvedValue({
        valid: false,
        reason: 'Asset not owned'
      });

      const results = await processor.process();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Asset not owned');
      expect(results[0].stage).toBe('validation');
    });

    it('should respect mempool capacity limit', async () => {
      // Set up 25 active transactions
      const activeTransactions = new Map();
      for (let i = 0; i < 25; i++) {
        activeTransactions.set(`order_${i}`, {
          orderHash: `order_${i}`,
          asset: 'ASSET',
          buyer: 'buyer',
          txid: `tx_${i}`,
          originalTxid: `tx_${i}`,
          rbfHistory: [`tx_${i}`],
          broadcastTime: Date.now(),
          broadcastBlock: 850000,
          feeRate: 20,
          isRbf: false,
          rbfCount: 0
        });
      }
      (processor as any).processingState.orderTransactions = activeTransactions;

      mockCounterparty.getFilledXCPFOLIOOrders.mockResolvedValue([mockFilledOrder]);

      const results = await processor.process();

      expect(results).toHaveLength(0);
      expect(mockCounterparty.composeTransfer).not.toHaveBeenCalled();
    });

    it('should wait when fees exceed limit', async () => {
      mockCounterparty.getFilledXCPFOLIOOrders.mockResolvedValue([mockFilledOrder]);
      mockCounterparty.isAssetTransferredTo.mockResolvedValue(false);
      mockBitcoin.getOptimalFeeRate.mockResolvedValue(150); // Above 100 sat/vB limit

      const results = await processor.process();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Fee rate too high');
      expect(results[0].stage).toBe('compose');

      expect(mockCounterparty.composeTransfer).not.toHaveBeenCalled();
    });

    it('should enforce fee ceiling', async () => {
      mockCounterparty.getFilledXCPFOLIOOrders.mockResolvedValue([mockFilledOrder]);
      mockCounterparty.isAssetTransferredTo.mockResolvedValue(false);
      mockBitcoin.getOptimalFeeRate.mockResolvedValue(50);
      mockBitcoin.signTransaction.mockResolvedValue({
        hex: '0200000001...',
        txid: 'tx123',
        fee: 15000, // Exceeds 10000 sats ceiling
        vsize: 250
      });

      const results = await processor.process();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('exceeds maximum');
      expect(results[0].stage).toBe('sign');

      expect(mockBitcoin.broadcastTransaction).not.toHaveBeenCalled();
    });
  });

  describe('RBF Handling', () => {
    it('should attempt RBF for stuck transaction', async () => {
      // Set up a stuck transaction that needs RBF
      const stuckTx = {
        orderHash: 'stuck_order',
        asset: 'RAREPEPE',
        buyer: 'buyer_address',
        txid: 'stuck_tx',
        originalTxid: 'stuck_tx',
        rbfHistory: ['stuck_tx'],
        broadcastTime: Date.now() - 3600000, // 1 hour ago
        broadcastBlock: 849996, // 4 blocks ago
        feeRate: 10,
        isRbf: false,
        rbfCount: 0,
        needsRbf: true  // Mark as needing RBF
      };
      
      (processor as any).processingState.orderTransactions.set('stuck_order', stuckTx);
      mockBitcoin.getCurrentBlockHeight.mockResolvedValue(850000);
      mockBitcoin.getOptimalFeeRate.mockResolvedValue(20);
      mockBitcoin.isInMempool.mockResolvedValue(true); // Transaction still in mempool
      mockBitcoin.fetchUTXOs.mockResolvedValue([mockUTXO]); // UTXOs available
      mockCounterparty.getFilledXCPFOLIOOrders.mockResolvedValue([]);
      mockCounterparty.composeTransfer.mockResolvedValue('02000000...'); // Mock raw transaction

      const results = await processor.process();

      // Should attempt RBF
      expect(mockCounterparty.composeTransfer).toHaveBeenCalledWith(
        expect.any(String),
        'RAREPEPE',
        'buyer_address',
        expect.any(Number), // New fee rate
        expect.any(Array),
        'auto',
        false // validate=false for RBF
      );
    });

    it('should handle dropped transactions', async () => {
      const droppedTx = {
        orderHash: 'dropped_order',
        asset: 'RAREPEPE',
        buyer: 'buyer_address',
        txid: 'dropped_tx',
        originalTxid: 'dropped_tx',
        rbfHistory: ['dropped_tx'],
        broadcastTime: Date.now(),
        broadcastBlock: 850000,
        feeRate: 10,
        isRbf: false,
        rbfCount: 0,
        droppedFromMempool: true
      };

      (processor as any).processingState.orderTransactions.set('dropped_order', droppedTx);
      mockBitcoin.isInMempool.mockResolvedValue(false);
      mockBitcoin.getTransaction.mockRejectedValue(new Error('Not found'));
      mockCounterparty.getFilledXCPFOLIOOrders.mockResolvedValue([]);

      const results = await processor.process();

      // Should immediately attempt RBF for dropped tx
      expect(mockCounterparty.composeTransfer).toHaveBeenCalled();
    });

    it('should respect RBF fee ceiling', async () => {
      const highFeeTx = {
        orderHash: 'high_fee_order',
        asset: 'RAREPEPE',
        buyer: 'buyer_address',
        txid: 'high_fee_tx',
        originalTxid: 'high_fee_tx',
        rbfHistory: ['high_fee_tx'],
        broadcastTime: Date.now(),
        broadcastBlock: 849996,
        feeRate: 39, // Near ceiling (40 sat/vB * 250 bytes = 10000 sats)
        isRbf: false,
        rbfCount: 0
      };

      (processor as any).processingState.orderTransactions.set('high_fee_order', highFeeTx);
      mockBitcoin.getCurrentBlockHeight.mockResolvedValue(850000);
      mockCounterparty.getFilledXCPFOLIOOrders.mockResolvedValue([]);

      const results = await processor.process();

      // Should not RBF if can't increase fee within ceiling
      expect(results).toHaveLength(0);
    });
  });

  describe('Single Worker Lock', () => {
    it('should prevent concurrent processing', async () => {
      mockCounterparty.getFilledXCPFOLIOOrders.mockResolvedValue([mockFilledOrder]);
      
      // Start two processes simultaneously
      const promise1 = processor.process();
      const promise2 = processor.process();

      const [results1, results2] = await Promise.all([promise1, promise2]);

      // Only one should process
      expect(results1.length + results2.length).toBe(1);
    });
  });

  describe('Error Handling', () => {
    it('should handle compose errors', async () => {
      mockCounterparty.getFilledXCPFOLIOOrders.mockResolvedValue([mockFilledOrder]);
      mockCounterparty.isAssetTransferredTo.mockResolvedValue(false);
      mockCounterparty.composeTransfer.mockRejectedValue(new Error('Insufficient balance'));

      const results = await processor.process();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Insufficient balance');
      expect(results[0].stage).toBe('compose');
    });

    it('should handle signing errors', async () => {
      mockCounterparty.getFilledXCPFOLIOOrders.mockResolvedValue([mockFilledOrder]);
      mockCounterparty.isAssetTransferredTo.mockResolvedValue(false);
      mockBitcoin.signTransaction.mockRejectedValue(new Error('Invalid private key'));

      const results = await processor.process();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Invalid private key');
      expect(results[0].stage).toBe('sign');
    });

    it('should handle broadcast errors gracefully', async () => {
      mockCounterparty.getFilledXCPFOLIOOrders.mockResolvedValue([mockFilledOrder]);
      mockCounterparty.isAssetTransferredTo.mockResolvedValue(false);
      mockBitcoin.broadcastTransaction.mockRejectedValue(new Error('Network error'));

      const results = await processor.process();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Network error');
      expect(results[0].stage).toBe('broadcast');
    });
  });
});