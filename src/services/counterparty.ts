import { Order, Issuance, Block, ComposeResponse, BroadcastResponse } from '../types';

const API_BASE = process.env.COUNTERPARTY_API || 'https://api.counterparty.io/v2';

export class CounterpartyService {
  private async fetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const url = `${API_BASE}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message || 'API error');
    }

    return data.result;
  }

  /**
   * Get current block info
   */
  async getCurrentBlock(): Promise<Block> {
    const blocks = await this.fetch<Block[]>('/blocks?limit=1');
    return blocks[0];
  }

  /**
   * Get orders for an address
   */
  async getOrdersByAddress(
    address: string,
    status: string = 'all',
    includeUnconfirmed: boolean = true
  ): Promise<Order[]> {
    const params = new URLSearchParams({
      status,
      show_unconfirmed: includeUnconfirmed.toString(),
      limit: '100',
      sort: 'block_index:desc',
    });

    return this.fetch<Order[]>(`/addresses/${address}/orders?${params}`);
  }

  /**
   * Get filled XCPFOLIO orders
   */
  async getFilledXCPFOLIOOrders(address: string): Promise<Order[]> {
    const orders = await this.getOrdersByAddress(address, 'filled', true);
    
    // Filter for XCPFOLIO.* subassets where we're the seller
    return orders.filter(order => 
      order.give_asset.startsWith('XCPFOLIO.') &&
      order.status === 'filled'
    );
  }

  /**
   * Get issuances for an asset
   */
  async getAssetIssuances(asset: string, includeUnconfirmed: boolean = true): Promise<Issuance[]> {
    const params = new URLSearchParams({
      show_unconfirmed: includeUnconfirmed.toString(),
      limit: '100',
    });

    return this.fetch<Issuance[]>(`/assets/${asset}/issuances?${params}`);
  }

  /**
   * Check if asset has been transferred to an address
   */
  async isAssetTransferredTo(asset: string, toAddress: string, fromAddress: string): Promise<boolean> {
    const issuances = await this.getAssetIssuances(asset, true);
    
    // Look for a transfer from our address to the buyer
    return issuances.some(issuance => 
      issuance.transfer === true &&
      issuance.source === fromAddress &&
      issuance.issuer === toAddress
    );
  }

  /**
   * Compose an issuance transfer transaction
   */
  async composeTransfer(
    source: string,
    asset: string,
    destination: string,
    feeRate: number
  ): Promise<string> {
    const params = {
      source,
      asset,
      quantity: 0, // No new tokens
      transfer_destination: destination,
      description: '', // Blank description as specified
      fee_rate: feeRate,
    };

    const response = await this.fetch<ComposeResponse>('/compose/issuance', {
      method: 'POST',
      body: JSON.stringify(params),
    });

    return response.rawtransaction;
  }

  /**
   * Broadcast a signed transaction
   */
  async broadcastTransaction(signedTx: string): Promise<string> {
    const response = await this.fetch<BroadcastResponse>('/broadcast', {
      method: 'POST',
      body: JSON.stringify({ signed_tx: signedTx }),
    });

    return response.tx_hash;
  }
}