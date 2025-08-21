import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface FulfillmentState {
  lastBlock: number;
  lastOrderHash: string | null;
  lastChecked: number;
  processedOrders: Set<string>;  // Only confirmed transfers
  lastCleanup: number;  // Last block we cleaned up old orders
}

export class StateManager {
  private state: FulfillmentState;
  private statePath: string;

  constructor(statePath?: string) {
    this.statePath = statePath || join(process.cwd(), '.fulfillment-state.json');
    this.state = this.loadState();
  }

  private loadState(): FulfillmentState {
    if (existsSync(this.statePath)) {
      try {
        const data = JSON.parse(readFileSync(this.statePath, 'utf-8'));
        return {
          ...data,
          processedOrders: new Set(data.processedOrders || []),
          lastCleanup: data.lastCleanup || 0,
        };
      } catch (error) {
        console.error('Error loading state:', error);
      }
    }

    // Default state
    return {
      lastBlock: 0,
      lastOrderHash: null,
      lastChecked: 0,
      processedOrders: new Set(),
      lastCleanup: 0,
    };
  }

  private saveState(): void {
    const stateToSave = {
      ...this.state,
      processedOrders: Array.from(this.state.processedOrders),
    };
    writeFileSync(this.statePath, JSON.stringify(stateToSave, null, 2));
  }

  getLastBlock(): number {
    return this.state.lastBlock;
  }

  setLastBlock(block: number): void {
    this.state.lastBlock = block;
    this.saveState();
  }

  getLastOrderHash(): string | null {
    return this.state.lastOrderHash;
  }

  setLastOrderHash(hash: string): void {
    this.state.lastOrderHash = hash;
    this.saveState();
  }

  isOrderProcessed(orderHash: string): boolean {
    return this.state.processedOrders.has(orderHash);
  }

  markOrderProcessed(orderHash: string): void {
    this.state.processedOrders.add(orderHash);
    this.state.lastChecked = Date.now();
    this.saveState();
  }

  unmarkOrderProcessed(orderHash: string): void {
    this.state.processedOrders.delete(orderHash);
    this.saveState();
  }

  shouldCheckForNewOrders(currentBlock: number): boolean {
    // Check if we have a new block
    return currentBlock > this.state.lastBlock;
  }

  getState(): FulfillmentState {
    return { ...this.state, processedOrders: new Set(this.state.processedOrders) };
  }

  reset(): void {
    this.state = {
      lastBlock: 0,
      lastOrderHash: null,
      lastChecked: 0,
      processedOrders: new Set(),
      lastCleanup: 0,
    };
    this.saveState();
  }

  getLastCleanup(): number {
    return this.state.lastCleanup || 0;
  }

  setLastCleanup(block: number): void {
    this.state.lastCleanup = block;
    this.saveState();
  }

  /**
   * Remove old orders from processedOrders set
   * Returns the number of orders removed
   */
  cleanupOldOrders(orderHashes: Set<string>, beforeBlock: number): number {
    const initialSize = this.state.processedOrders.size;
    
    // Only keep orders that are NOT in the old orders set
    const newProcessedOrders = new Set<string>();
    for (const hash of this.state.processedOrders) {
      if (!orderHashes.has(hash)) {
        newProcessedOrders.add(hash);
      }
    }
    
    this.state.processedOrders = newProcessedOrders;
    this.saveState();
    
    return initialSize - newProcessedOrders.size;
  }
}