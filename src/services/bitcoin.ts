import { Transaction, p2pkh, SigHash } from '@scure/btc-signer';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import * as secp256k1 from 'secp256k1';
import { base58check } from '@scure/base';
import axios from 'axios';
import { API_CONFIG, TX_SIZE, TIME } from '../constants';

export interface UTXO {
  txid: string;
  vout: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
  value: number;
}

export interface FeeRates {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}

export interface SignedTransaction {
  hex: string;
  txid: string;
  fee: number;
  vsize: number;
}

const MEMPOOL_API = process.env.MEMPOOL_API || API_CONFIG.MEMPOOL.DEFAULT_URL;
const COUNTERPARTY_API = process.env.COUNTERPARTY_API || API_CONFIG.COUNTERPARTY.DEFAULT_URL;

/**
 * Convert WIF private key to hex
 * For mainnet P2PKH addresses (starting with 1)
 */
function wifToPrivateKey(wif: string): string {
  try {
    // Decode base58check
    const decoded = base58check(sha256).decode(wif);
    
    // First byte is version (0x80 for mainnet, 0xef for testnet)
    // Last byte might be compression flag (0x01)
    const hasCompressionFlag = decoded.length === 34;
    
    // Extract private key (32 bytes)
    const privateKey = decoded.slice(1, 33);
    
    return bytesToHex(privateKey);
  } catch (error) {
    throw new Error(`Invalid WIF private key: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Bitcoin service for P2PKH addresses
 * Handles transaction signing, broadcasting, and fee management
 */
export class BitcoinService {
  private isTestnet: boolean;

  constructor(network: 'mainnet' | 'testnet' = 'mainnet') {
    this.isTestnet = network === 'testnet';
  }

  /**
   * Get current block height from mempool.space
   */
  async getCurrentBlockHeight(): Promise<number> {
    try {
      const response = await axios.get<number>(`${MEMPOOL_API}/blocks/tip/height`);
      return response.data;
    } catch (error) {
      console.error('Error fetching block height:', error);
      throw new Error('Failed to fetch block height');
    }
  }

  /**
   * Fetch UTXOs for a given address
   */
  async fetchUTXOs(address: string): Promise<UTXO[]> {
    try {
      const response = await axios.get<UTXO[]>(`${MEMPOOL_API}/address/${address}/utxo`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching UTXOs for address ${address}:`, error);
      throw new Error('Failed to fetch UTXOs');
    }
  }

  /**
   * Format UTXOs for Counterparty API inputs_set parameter
   */
  formatInputsSet(utxos: UTXO[]): string {
    return utxos.map(utxo => `${utxo.txid}:${utxo.vout}`).join(',');
  }

  /**
   * Fetch raw transaction hex
   */
  async fetchRawTransaction(txid: string): Promise<string> {
    try {
      // Try Counterparty API first
      const response = await axios.get<{ result: any }>(
        `${COUNTERPARTY_API}/bitcoin/transactions/${txid}`
      );
      
      if (response.data?.result?.hex) {
        return response.data.result.hex;
      }
      
      // Fallback to mempool.space
      const mempoolResponse = await axios.get(`${MEMPOOL_API}/tx/${txid}/hex`);
      return mempoolResponse.data;
    } catch (error) {
      console.error(`Error fetching raw transaction for ${txid}:`, error);
      throw new Error(`Failed to fetch raw transaction: ${txid}`);
    }
  }

  /**
   * Get recommended fee rates
   */
  async getFeeRates(): Promise<FeeRates> {
    try {
      const response = await axios.get<FeeRates>(`${MEMPOOL_API}/v1/fees/recommended`);
      return response.data;
    } catch (error) {
      console.warn('Failed to fetch fee rates, using fallback');
      return {
        fastestFee: 20,
        halfHourFee: 15,
        hourFee: 10,
        economyFee: 5,
        minimumFee: 1
      };
    }
  }

  /**
   * Get optimal fee rate for 1-block confirmation target
   */
  async getOptimalFeeRate(): Promise<number> {
    const fees = await this.getFeeRates();
    // Target 1-block confirmation
    return fees.fastestFee;
  }

  /**
   * Sign a raw transaction for P2PKH address
   */
  async signTransaction(
    rawTransaction: string,
    sourceAddress: string,
    privateKeyWIF: string,
    sequenceNumber: number = 0xfffffffd  // RBF enabled by default
  ): Promise<SignedTransaction> {
    try {
      // Convert WIF to hex
      const privateKeyHex = wifToPrivateKey(privateKeyWIF);
      const privateKeyBytes = hexToBytes(privateKeyHex);
      const pubkeyBytes = secp256k1.publicKeyCreate(privateKeyBytes, true); // compressed
      
      // Create P2PKH payment script
      const payment = p2pkh(pubkeyBytes);

      // Fetch UTXOs for the address with retry
      let utxos = await this.fetchUTXOs(sourceAddress);
      if (!utxos || utxos.length === 0) {
        await new Promise(resolve => setTimeout(resolve, TIME.SECOND));
        utxos = await this.fetchUTXOs(sourceAddress);
        if (!utxos || utxos.length === 0) {
          throw new Error('No UTXOs found for source address');
        }
      }

      // Parse the raw transaction
      const rawTxBytes = hexToBytes(rawTransaction);
      const parsedTx = Transaction.fromRaw(rawTxBytes, {
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
        allowLegacyWitnessUtxo: true,
        disableScriptCheck: true
      });

      // Create new transaction for signing
      const tx = new Transaction({
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
        allowLegacyWitnessUtxo: true,
        disableScriptCheck: true
      });

      // Process inputs
      let totalIn = 0;
      for (let i = 0; i < parsedTx.inputsLength; i++) {
        const input = parsedTx.getInput(i);
        if (!input?.txid || input.index === undefined) {
          throw new Error(`Invalid input at index ${i}`);
        }

        const txidHex = bytesToHex(input.txid);
        const utxo = utxos.find(u => u.txid === txidHex && u.vout === input.index);
        
        if (!utxo) {
          // Try fetching fresh UTXOs once more
          console.warn(`UTXO not found for ${txidHex}:${input.index}, retrying...`);
          await new Promise(resolve => setTimeout(resolve, TIME.SECOND));
          const freshUtxos = await this.fetchUTXOs(sourceAddress);
          const freshUtxo = freshUtxos.find(u => u.txid === txidHex && u.vout === input.index);
          
          if (!freshUtxo) {
            throw new Error(`UTXO not found for input ${i}: ${txidHex}:${input.index}`);
          }
          utxos = freshUtxos;
        }

        // Fetch the previous transaction for P2PKH
        const rawPrevTx = await this.fetchRawTransaction(txidHex);
        
        // Add input with nonWitnessUtxo for P2PKH
        tx.addInput({
          txid: input.txid,
          index: input.index,
          sequence: sequenceNumber,  // Use provided sequence (RBF enabled)
          sighashType: SigHash.ALL,
          nonWitnessUtxo: hexToBytes(rawPrevTx)
        });

        const foundUtxo = utxos.find(u => u.txid === txidHex && u.vout === input.index);
        if (foundUtxo) {
          totalIn += foundUtxo.value;
        }
      }

      // Add outputs
      let totalOut = 0;
      for (let i = 0; i < parsedTx.outputsLength; i++) {
        const output = parsedTx.getOutput(i);
        tx.addOutput({
          script: output.script,
          amount: output.amount,
        });
        totalOut += Number(output.amount);
      }

      // Sign and finalize
      tx.sign(privateKeyBytes);
      tx.finalize();

      // Get signed hex and calculate metadata
      const signedHex = tx.hex;
      const vsize = Math.ceil(signedHex.length / 2);
      const fee = totalIn - totalOut;

      // Calculate txid (double SHA256 of raw tx, reversed)
      const txBytes = hexToBytes(signedHex);
      const hash1 = sha256(txBytes);
      const hash2 = sha256(hash1);
      const txid = bytesToHex(hash2.reverse());

      return {
        hex: signedHex,
        txid,
        fee,
        vsize
      };
    } catch (error) {
      console.error('Error signing transaction:', error);
      throw new Error(`Failed to sign transaction: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Broadcast a signed transaction with multiple endpoints
   */
  async broadcastTransaction(signedTxHex: string): Promise<string> {
    const endpoints = [
      {
        name: 'counterparty',
        url: `${COUNTERPARTY_API}/bitcoin/transactions?signedhex=${encodeURIComponent(signedTxHex)}`,
        method: 'GET' as const,
        extractTxid: (response: any) => response.data?.result
      },
      {
        name: 'mempool',
        url: `${MEMPOOL_API}/tx`,
        method: 'POST' as const,
        data: signedTxHex,
        headers: { 'Content-Type': 'text/plain' },
        extractTxid: (response: any) => response.data
      },
      {
        name: 'blockstream',
        url: `${API_CONFIG.BLOCKSTREAM.DEFAULT_URL}/tx`,
        method: 'POST' as const,
        data: signedTxHex,
        headers: { 'Content-Type': 'text/plain' },
        extractTxid: (response: any) => response.data
      }
    ];

    let lastError: Error | null = null;

    for (const endpoint of endpoints) {
      try {
        const config: any = {
          method: endpoint.method,
          url: endpoint.url,
          headers: endpoint.headers || {}
        };

        if (endpoint.data) {
          config.data = endpoint.data;
        }

        const response = await axios(config);
        const txid = endpoint.extractTxid(response);
        
        if (txid) {
          console.log(`Transaction broadcast successful via ${endpoint.name}: ${txid}`);
          return txid;
        }
      } catch (error) {
        lastError = error as Error;
        
        // Check for "already in mempool" type errors
        if (axios.isAxiosError(error) && error.response?.data) {
          const errorMsg = JSON.stringify(error.response.data).toLowerCase();
          if (errorMsg.includes('already') || errorMsg.includes('mempool')) {
            // Try to extract txid from error message
            const match = errorMsg.match(/[a-f0-9]{64}/);
            if (match) {
              console.log(`Transaction already in mempool: ${match[0]}`);
              return match[0];
            }
          }
          
          // Log the actual error response for debugging
          console.error(`Failed to broadcast via ${endpoint.name}:`, {
            status: error.response.status,
            statusText: error.response.statusText,
            error: error.response.data
          });
        } else {
          console.error(`Failed to broadcast via ${endpoint.name}:`, error instanceof Error ? error.message : String(error));
        }
      }
    }

    throw new Error(`Failed to broadcast transaction: ${lastError?.message || 'Unknown error'}`);
  }

  /**
   * Check if a transaction is in the mempool
   */
  async isInMempool(txid: string): Promise<boolean> {
    try {
      const response = await axios.get(`${MEMPOOL_API}/tx/${txid}`);
      return response.data && !response.data.status?.confirmed;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get transaction details
   */
  async getTransaction(txid: string): Promise<any> {
    try {
      const response = await axios.get(`${MEMPOOL_API}/tx/${txid}`);
      return response.data;
    } catch (error) {
      throw new Error(`Transaction not found: ${txid}`);
    }
  }

  /**
   * Estimate transaction fee for P2PKH
   * P2PKH: ~148 bytes per input, ~34 bytes per output, ~10 bytes overhead
   */
  async estimateFee(
    numInputs: number,
    numOutputs: number,
    feeRate?: number
  ): Promise<number> {
    if (!feeRate) {
      feeRate = await this.getOptimalFeeRate();
    }

    const estimatedSize = TX_SIZE.OVERHEAD + (TX_SIZE.INPUT * numInputs) + (TX_SIZE.OUTPUT * numOutputs);
    return Math.ceil(estimatedSize * feeRate);
  }
}