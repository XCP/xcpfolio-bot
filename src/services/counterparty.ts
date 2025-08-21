import axios from 'axios';
import { Order, Issuance, Block } from '../types';
import { UTXO } from './bitcoin';
import { API_CONFIG, ASSET_CONFIG, STATUS } from '../constants';

const API_BASE = process.env.COUNTERPARTY_API || API_CONFIG.COUNTERPARTY.DEFAULT_URL;

export interface ComposeIssuanceParams {
  source: string;
  asset: string;
  quantity: number;
  transfer_destination?: string;
  divisible?: boolean;
  description?: string;
  lock?: boolean;
  reset?: boolean;
  encoding?: 'auto' | 'opreturn' | 'multisig' | 'pubkeyhash';
  fee_rate?: number;
  inputs_set?: string;
  dust_return_pubkey?: string;
  validate?: boolean;
  allow_unconfirmed_inputs?: boolean;
}

export interface ComposeResponse {
  rawtransaction: string;
  btc_in: number;
  btc_out: number;
  btc_change: number;
  btc_fee: number;
  data: string;
  params: any;
  name: string;
}

export interface BroadcastResponse {
  tx_hash: string;
}

export interface AssetInfo {
  asset: string;
  asset_id: string;
  asset_longname: string | null;
  issuer: string;
  owner: string;
  divisible: boolean;
  locked: boolean;
  supply: number;
  description: string;
  description_locked: boolean;
  first_issuance_block_index?: number;
  last_issuance_block_index?: number;
}

/**
 * Counterparty API service
 * Handles all interactions with the Counterparty protocol
 */
export class CounterpartyService {
  private apiBase: string;

  constructor(apiBase?: string) {
    this.apiBase = apiBase || API_BASE;
  }

  /**
   * Make a request to the Counterparty API
   */
  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' = 'GET',
    data?: any
  ): Promise<T> {
    try {
      const url = `${this.apiBase}${endpoint}`;
      const config: any = {
        method,
        url,
        headers: {
          'Content-Type': 'application/json',
        }
      };

      if (method === 'POST' && data) {
        config.data = data;
      }

      console.log(`[Counterparty API] ${method} ${url}`);
      if (data) {
        console.log('[Counterparty API] Request body:', JSON.stringify(data, null, 2));
      }

      const response = await axios(config);
      
      if (response.data.error) {
        throw new Error(response.data.error.message || 'API error');
      }

      return response.data.result;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('[Counterparty API] Error response:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          url: error.config?.url
        });
        const errorMessage = error.response?.data?.error?.message || error.message;
        throw new Error(`Counterparty API error: ${errorMessage}`);
      }
      throw error;
    }
  }

  /**
   * Get current block info
   */
  async getCurrentBlock(): Promise<Block> {
    const blocks = await this.request<Block[]>('/blocks?limit=1');
    return blocks[0];
  }

  /**
   * Get orders for an address with pagination support
   */
  async getOrdersByAddress(
    address: string,
    status: string = 'all',
    limit: number = 100,
    offset: number = 0
  ): Promise<Order[]> {
    const params = new URLSearchParams({
      status,
      show_unconfirmed: 'true',
      verbose: 'true',  // Get asset_info with longnames
      limit: limit.toString(),
      offset: offset.toString(),
      sort: 'block_index:desc',
    });

    return this.request<Order[]>(`/addresses/${address}/orders?${params}`);
  }

  /**
   * Get order matches for a specific order
   */
  async getOrderMatches(orderHash: string): Promise<any[]> {
    const params = new URLSearchParams({
      verbose: 'true',
      show_unconfirmed: 'true'
    });
    
    return this.request<any[]>(`/orders/${orderHash}/matches?${params}`);
  }

  /**
   * Get all filled XCPFOLIO orders
   */
  async getFilledXCPFOLIOOrders(address: string): Promise<Order[]> {
    const allOrders: Order[] = [];
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      const orders = await this.getOrdersByAddress(address, 'filled', limit, offset);
      
      // Filter for XCPFOLIO.* subassets using longname or fallback
      const xcpfolioOrders = orders.filter(order => {
        const assetName = order.give_asset_info?.asset_longname || order.give_asset;
        return assetName.startsWith(ASSET_CONFIG.XCPFOLIO_PREFIX) && order.status === STATUS.FILLED;
      });

      allOrders.push(...xcpfolioOrders);

      // Check if we should continue
      if (orders.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
      }
    }

    return allOrders;
  }

  /**
   * Get issuances for an asset
   */
  async getAssetIssuances(asset: string): Promise<Issuance[]> {
    const params = new URLSearchParams({
      show_unconfirmed: 'true',
      limit: '100',
    });

    return this.request<Issuance[]>(`/assets/${asset}/issuances?${params}`);
  }

  /**
   * Check if asset has been transferred to an address
   */
  async isAssetTransferredTo(
    asset: string,
    toAddress: string,
    fromAddress: string
  ): Promise<boolean> {
    const issuances = await this.getAssetIssuances(asset);
    
    // Look for a transfer from our address to the buyer
    return issuances.some(issuance => 
      issuance.transfer === true &&
      issuance.source === fromAddress &&
      issuance.issuer === toAddress
    );
  }

  /**
   * Compose an issuance transfer transaction with UTXO support
   */
  async composeTransfer(
    source: string,
    asset: string,
    destination: string,
    feeRate: number,
    utxos?: UTXO[],
    encoding: 'auto' | 'opreturn' | 'multisig' | 'pubkeyhash' = 'auto',
    validate: boolean = true  // Set to false for RBF transactions
  ): Promise<string> {
    // Build query parameters for issuance transfer
    const params = new URLSearchParams({
      asset,
      quantity: '0', // 0 for ownership transfer
      transfer_destination: destination,
      description: '', // Empty description for transfer
      fee_rate: feeRate.toString(),
      encoding,
      validate: validate.toString(),
      allow_unconfirmed_inputs: 'true'
    });

    // If UTXOs provided, format them for inputs_set
    if (utxos && utxos.length > 0) {
      params.append('inputs_set', utxos.map(u => `${u.txid}:${u.vout}`).join(','));
    }

    // In v2 API, compose endpoints use query parameters
    const response = await this.request<ComposeResponse>(
      `/addresses/${source}/compose/issuance?${params.toString()}`,
      'GET'
    );

    return response.rawtransaction;
  }

  /**
   * Compose an issuance with full parameters
   */
  async composeIssuance(params: ComposeIssuanceParams): Promise<ComposeResponse> {
    // Extract source from params for v2 API path
    const { source, ...restParams } = params;
    return this.request<ComposeResponse>(`/addresses/${source}/compose/issuance`, 'POST', restParams);
  }

  /**
   * Broadcast a signed transaction
   */
  async broadcastTransaction(signedTx: string): Promise<string> {
    const response = await this.request<BroadcastResponse>(
      '/broadcast',
      'POST',
      { signed_tx: signedTx }
    );

    return response.tx_hash;
  }

  /**
   * Get asset info including ownership
   */
  async getAssetInfo(asset: string): Promise<AssetInfo> {
    return this.request<AssetInfo>(`/assets/${asset}`);
  }

  /**
   * Get address balances
   */
  async getAddressBalances(address: string): Promise<any[]> {
    return this.request<any[]>(`/addresses/${address}/balances`);
  }

  /**
   * Check if an order is valid and can be fulfilled
   */
  async validateOrder(order: Order): Promise<{
    valid: boolean;
    reason?: string;
    asset?: string;
  }> {
    try {
      // Check if the order is truly filled
      if (order.status !== STATUS.FILLED) {
        return { valid: false, reason: 'Order not filled' };
      }

      // Get the actual asset name from longname or fallback
      const xcpfolioAsset = order.give_asset_info?.asset_longname || order.give_asset;
      
      // Check if it's an XCPFOLIO asset
      if (!xcpfolioAsset.startsWith(ASSET_CONFIG.XCPFOLIO_PREFIX)) {
        return { valid: false, reason: 'Not an XCPFOLIO asset' };
      }

      // Extract the actual asset name
      const assetName = xcpfolioAsset.replace(ASSET_CONFIG.XCPFOLIO_PREFIX, '');

      // Check if the asset exists and we own it
      try {
        const assetInfo = await this.getAssetInfo(assetName);
        
        // Check if asset exists
        if (!assetInfo) {
          return { valid: false, reason: `Asset ${assetName} does not exist` };
        }

        // Return valid with asset name
        return { valid: true, asset: assetName };
        
      } catch (error) {
        return { valid: false, reason: `Asset ${assetName} validation failed: ${error instanceof Error ? error.message : String(error)}` };
      }

    } catch (error) {
      return { valid: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Get recent transfers for an address
   */
  async getRecentTransfers(
    address: string,
    limit: number = 100
  ): Promise<Issuance[]> {
    const params = new URLSearchParams({
      show_unconfirmed: 'true',
      limit: limit.toString(),
      sort: 'block_index:desc',
    });

    const issuances = await this.request<Issuance[]>(
      `/addresses/${address}/issuances?${params}`
    );

    return issuances.filter(i => i.transfer === true);
  }

  /**
   * Get unconfirmed buy orders for XCPFOLIO assets from mempool
   * These are orders where someone is trying to buy an XCPFOLIO asset with XCP
   */
  async getMempoolBuyOrders(): Promise<any[]> {
    try {
      const params = new URLSearchParams({
        verbose: 'true'
      });
      
      const events = await this.request<any[]>(`/mempool/events/OPEN_ORDER?${params}`);
      
      // Filter for orders where someone is buying (getting) XCPFOLIO.* assets
      return events.filter(event => {
        const assetLongname = event.params?.get_asset_info?.asset_longname;
        const giveAsset = event.params?.give_asset;
        
        // Check if they're getting an XCPFOLIO asset and giving XCP
        return assetLongname && 
               assetLongname.startsWith(ASSET_CONFIG.XCPFOLIO_PREFIX) &&
               giveAsset === 'XCP';
      });
    } catch (error) {
      console.error('Error fetching mempool buy orders:', error);
      return [];
    }
  }

  /**
   * Get pending orders that might need fulfillment
   */
  async getPendingFulfillments(
    xcpfolioAddress: string,
    lastProcessedBlock?: number
  ): Promise<Order[]> {
    const orders = await this.getFilledXCPFOLIOOrders(xcpfolioAddress);
    
    if (lastProcessedBlock) {
      return orders.filter(o => o.block_index > lastProcessedBlock);
    }
    
    return orders;
  }
}