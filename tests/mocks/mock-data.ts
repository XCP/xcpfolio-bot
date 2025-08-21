/**
 * Mock data for testing
 */

import { Order, Issuance, Block } from '../../src/types';

export const mockBlock: Block = {
  block_index: 850000,
  block_hash: '00000000000000000002c0cc73626b56fb3ee1ce605b0ce125cc4fb58775a0a9',
  block_time: 1700000000,
  previous_block_hash: '00000000000000000001234567890abcdef1234567890abcdef1234567890ab',
  difficulty: 12345678,
  ledger_hash: 'abcdef1234567890',
  txlist_hash: 'fedcba0987654321',
  messages_hash: '1234567890abcdef'
};

export const mockFilledOrder: Order = {
  tx_index: 1000,
  tx_hash: 'order_tx_hash_12345',
  block_index: 849999,
  source: 'buyer_address_12345',  // buyer
  give_asset: 'XCPFOLIO.RAREPEPE',
  give_quantity: 1,
  give_remaining: 0,
  get_asset: 'XCP',
  get_quantity: 100000000,
  get_remaining: 0,
  expiration: 1000,
  expire_index: 851000,
  fee_required: 0,
  fee_required_remaining: 0,
  fee_provided: 10000,
  fee_provided_remaining: 0,
  status: 'filled',
  confirmed: true,
  block_time: 1699999000,
  give_asset_info: {
    asset_longname: 'XCPFOLIO.RAREPEPE',
    asset: 'XCPFOLIO.RAREPEPE',
    divisible: false,
    description: 'Ownership token for RAREPEPE'
  }
};

export const mockPendingOrder: Order = {
  ...mockFilledOrder,
  tx_hash: 'pending_order_hash_67890',
  status: 'open',
  give_remaining: 1
};

export const mockIssuance: Issuance = {
  tx_index: 2000,
  tx_hash: 'issuance_tx_hash_12345',
  block_index: 850000,
  asset: 'RAREPEPE',
  quantity: 0,
  divisible: false,
  source: '1TestAddressDoNotUse',
  issuer: 'buyer_address_12345',
  transfer: true,
  callable: false,
  description: '',
  lock: false,
  reset: false,
  block_time: 1700000000,
  confirmed: true
};

export const mockUTXO = {
  txid: 'utxo_txid_12345',
  vout: 0,
  status: {
    confirmed: true,
    block_height: 849000,
    block_hash: 'block_hash_12345',
    block_time: 1699900000
  },
  value: 100000  // 0.001 BTC
};

export const mockFeeRates = {
  fastestFee: 20,
  halfHourFee: 15,
  hourFee: 10,
  economyFee: 5,
  minimumFee: 1
};

export const mockRawTransaction = '0200000001abcd...'; // Simplified
export const mockSignedTransaction = {
  hex: '0200000001signed...',
  txid: 'broadcast_tx_12345',
  fee: 2500,
  vsize: 250
};

export const mockAssetInfo = {
  asset: 'RAREPEPE',
  asset_id: '123456789',
  asset_longname: null,
  issuer: '1TestAddressDoNotUse',
  owner: '1TestAddressDoNotUse',
  divisible: false,
  locked: false,
  supply: 1,
  description: 'Rare Pepe Card',
  description_locked: false
};