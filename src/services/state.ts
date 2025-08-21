import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface FulfillmentState {
  lastBlock: number;
  lastOrderHash: string | null;
  lastChecked: number;
  processedOrders: Set<string>;
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
    };
    this.saveState();
  }
}