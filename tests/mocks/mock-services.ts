/**
 * Mock service implementations for testing
 */

import * as mockData from './mock-data';

export class MockCounterpartyService {
  getCurrentBlock = jest.fn(() => Promise.resolve(mockData.mockBlock));
  
  getFilledXCPFOLIOOrders = jest.fn(() => Promise.resolve([mockData.mockFilledOrder]));
  
  validateOrder = jest.fn(() => Promise.resolve({
    valid: true,
    asset: 'RAREPEPE',
    reason: undefined
  } as { valid: boolean; asset?: string; reason?: string }));
  
  isAssetTransferredTo = jest.fn(() => Promise.resolve(false));
  
  composeTransfer = jest.fn(() => Promise.resolve(mockData.mockRawTransaction));
  
  getAssetInfo = jest.fn(() => Promise.resolve(mockData.mockAssetInfo));
  
  broadcastTransaction = jest.fn(() => Promise.resolve('broadcast_tx_12345'));
}

export class MockBitcoinService {
  getCurrentBlockHeight = jest.fn(() => Promise.resolve(850000));
  
  fetchUTXOs = jest.fn(() => Promise.resolve([mockData.mockUTXO]));
  
  getFeeRates = jest.fn(() => Promise.resolve(mockData.mockFeeRates));
  
  getOptimalFeeRate = jest.fn(() => Promise.resolve(20));
  
  signTransaction = jest.fn(() => Promise.resolve(mockData.mockSignedTransaction));
  
  broadcastTransaction = jest.fn(() => Promise.resolve('broadcast_tx_12345'));
  
  isInMempool = jest.fn(() => Promise.resolve(true));
  
  getTransaction = jest.fn(() => Promise.resolve({
    status: { confirmed: false }
  }));
}

export class MockStateManager {
  private processedOrders = new Set<string>();
  
  getLastBlock = jest.fn(() => 849000);
  
  setLastBlock = jest.fn();
  
  getLastOrderHash = jest.fn(() => null);
  
  setLastOrderHash = jest.fn();
  
  isOrderProcessed = jest.fn((hash: string) => this.processedOrders.has(hash));
  
  markOrderProcessed = jest.fn((hash: string) => {
    this.processedOrders.add(hash);
  });
  
  unmarkOrderProcessed = jest.fn((hash: string) => {
    this.processedOrders.delete(hash);
  });
  
  getState = jest.fn(() => ({
    lastBlock: 849000,
    lastOrderHash: null,
    lastChecked: Date.now(),
    processedOrders: this.processedOrders
  }));
  
  reset = jest.fn(() => {
    this.processedOrders.clear();
  });
}

/**
 * Create a mock fulfillment processor with all dependencies mocked
 */
export function createMockProcessor() {
  const mockCounterparty = new MockCounterpartyService();
  const mockBitcoin = new MockBitcoinService();
  const mockState = new MockStateManager();
  
  return {
    counterparty: mockCounterparty,
    bitcoin: mockBitcoin,
    state: mockState,
    config: {
      xcpfolioAddress: '1TestAddressDoNotUse',
      privateKey: 'cTestPrivateKeyDoNotUse',
      network: 'testnet' as const,
      dryRun: false,
      maxMempoolTxs: 25,
      composeCooldown: 100, // Short for tests
      maxPreBroadcastRetries: 3, // Less for tests
      rbfEnabled: true,
      stuckTxThreshold: 3,
      maxTotalFeeSats: 10000,
      maxFeeRateForNewTx: 100
    }
  };
}