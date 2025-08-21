/**
 * Mock implementations for crypto libraries used in tests
 */

// Mock @noble/secp256k1
export const secp256k1 = {
  utils: {
    randomPrivateKey: jest.fn(() => Buffer.alloc(32, 1))
  }
};

// Mock @scure/base
export const hex = {
  decode: jest.fn((str: string) => Buffer.from(str, 'hex')),
  encode: jest.fn((buf: Uint8Array) => Buffer.from(buf).toString('hex'))
};

export const base58check = {
  decode: jest.fn((str: string) => {
    // Mock WIF decode - return a fake private key
    return Buffer.concat([Buffer.alloc(32, 1), Buffer.from([0x01])]);
  }),
  encode: jest.fn((buf: Uint8Array) => 'cMockPrivateKey')
};

// Mock @scure/btc-signer
export class Transaction {
  version = 2;
  lockTime = 0;
  inputs: any[] = [];
  outputs: any[] = [];

  constructor(opts?: any) {
    if (opts) {
      Object.assign(this, opts);
    }
  }

  addInput(input: any) {
    this.inputs.push(input);
  }

  addOutput(output: any) {
    this.outputs.push(output);
  }

  finalize() {
    // Mock finalization
  }

  sign(privateKey: Uint8Array) {
    // Mock signing
  }

  get hex() {
    return '02000000010000000000000000000000000000000000000000000000000000000000000000ffffffff00ffffffff0100000000000000000000000000';
  }

  get id() {
    return 'mocktxid123456789';
  }

  get vsize() {
    return 250;
  }

  get fee() {
    return 5000n;
  }
}

export const p2pkh = jest.fn((pubkey: Uint8Array, network?: any) => ({
  script: Buffer.from('76a914' + '00'.repeat(20) + '88ac', 'hex'),
  address: '1MockAddress',
  type: 'pkh'
}));

export const NETWORK = {
  mainnet: { bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05 },
  testnet: { bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4 }
};

export const selectUTXO = jest.fn((utxos: any[], outputs: any[]) => {
  // Mock UTXO selection - just return first UTXOs
  return {
    inputs: utxos.slice(0, 2),
    outputs: outputs,
    fee: 5000n
  };
});

// Export everything as default for @scure/btc-signer
const btcSigner = {
  Transaction,
  p2pkh,
  NETWORK,
  selectUTXO
};

export default btcSigner;