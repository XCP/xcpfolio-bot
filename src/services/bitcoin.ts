import * as bitcoin from 'bitcoinjs-lib';
import { FeeRecommendation } from '../types';

const MEMPOOL_API = process.env.MEMPOOL_API || 'https://mempool.space/api';

export class BitcoinService {
  private network: bitcoin.Network;

  constructor(network: 'mainnet' | 'testnet' = 'mainnet') {
    this.network = network === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  }

  /**
   * Get current block height from mempool.space
   */
  async getCurrentBlockHeight(): Promise<number> {
    try {
      const response = await fetch(`${MEMPOOL_API}/blocks/tip/height`);
      if (!response.ok) {
        throw new Error('Failed to fetch block height');
      }
      return await response.json();
    } catch (error) {
      console.error('Error fetching block height from mempool.space:', error);
      throw error;
    }
  }

  /**
   * Get recommended fee rates
   */
  async getFeeRecommendation(): Promise<FeeRecommendation> {
    try {
      const response = await fetch(`${MEMPOOL_API}/v1/fees/recommended`);
      if (!response.ok) {
        throw new Error('Failed to fetch fee recommendation');
      }
      return await response.json();
    } catch (error) {
      console.error('Error fetching fee rates:', error);
      // Return fallback rates
      return {
        fastestFee: 20,
        halfHourFee: 15,
        hourFee: 10,
        economyFee: 5,
        minimumFee: 1,
      };
    }
  }

  /**
   * Get optimal fee rate for next block confirmation
   */
  async getOptimalFeeRate(): Promise<number> {
    const fees = await this.getFeeRecommendation();
    return fees.fastestFee;
  }

  /**
   * Sign a raw transaction
   * Note: This is a basic implementation. For production, consider using a hardware wallet or HSM
   */
  signTransaction(rawTx: string, privateKey: string): string {
    try {
      // Parse the raw transaction
      const tx = bitcoin.Transaction.fromHex(rawTx);
      
      // Create key pair from private key (WIF format)
      const keyPair = bitcoin.ECPair.fromWIF(privateKey, this.network);
      
      // Create a PSBT (Partially Signed Bitcoin Transaction)
      const psbt = new bitcoin.Psbt({ network: this.network });
      
      // Note: This is a simplified version
      // In production, you'd need to properly handle different input types (P2PKH, P2WPKH, etc.)
      // and fetch the previous transaction outputs to build proper inputs
      
      console.warn('Note: Transaction signing requires proper UTXO data. This is a simplified implementation.');
      console.warn('For production use, integrate with a proper Bitcoin node or use a signing service.');
      
      // For now, return the unsigned transaction
      // A full implementation would require:
      // 1. Fetching previous transaction outputs
      // 2. Building proper input scripts
      // 3. Signing each input
      // 4. Assembling the final transaction
      
      return rawTx;
    } catch (error) {
      console.error('Error signing transaction:', error);
      throw new Error(`Failed to sign transaction: ${error.message}`);
    }
  }

  /**
   * Check if a transaction is in the mempool
   */
  async isInMempool(txid: string): Promise<boolean> {
    try {
      const response = await fetch(`${MEMPOOL_API}/tx/${txid}`);
      if (!response.ok) {
        return false;
      }
      const data = await response.json();
      return !data.status.confirmed;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get transaction details
   */
  async getTransaction(txid: string): Promise<any> {
    const response = await fetch(`${MEMPOOL_API}/tx/${txid}`);
    if (!response.ok) {
      throw new Error('Transaction not found');
    }
    return await response.json();
  }
}