export interface Order {
  tx_index: number;
  tx_hash: string;
  block_index: number;
  source: string; // buyer address
  give_asset: string; // XCPFOLIO.ASSETNAME
  give_quantity: number;
  give_remaining: number;
  get_asset: string; // XCP
  get_quantity: number;
  get_remaining: number;
  expiration: number;
  expire_index: number;
  fee_required: number;
  fee_required_remaining: number;
  fee_provided: number;
  fee_provided_remaining: number;
  status: string;
  confirmed: boolean;
  block_time?: number;
  give_asset_info?: {
    asset_longname: string | null;  // The actual subasset name
    asset: string;
    divisible: boolean;
    description: string;
  };
  get_asset_info?: {
    asset_longname: string | null;
    asset: string;
    divisible: boolean;
    description: string;
  };
}

export interface Issuance {
  tx_index: number;
  tx_hash: string;
  block_index: number;
  asset: string;
  quantity: number;
  divisible: boolean;
  source: string;
  issuer: string;
  transfer: boolean;
  callable: boolean;
  description: string;
  lock: boolean;
  reset: boolean;
  block_time?: number;
  confirmed: boolean;
}

export interface Block {
  block_index: number;
  block_hash: string;
  block_time: number;
  previous_block_hash: string;
  difficulty: number;
  ledger_hash: string;
  txlist_hash: string;
  messages_hash: string;
}

export interface ComposeResponse {
  rawtransaction: string;
  params: Record<string, any>;
  name: string;
}

export interface BroadcastResponse {
  tx_hash: string;
}

export interface FeeRecommendation {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}