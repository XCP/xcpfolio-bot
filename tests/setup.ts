/**
 * Jest Test Setup
 * Configure test environment and global mocks
 */

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.NETWORK = 'testnet';
process.env.DRY_RUN = 'true';
process.env.XCPFOLIO_ADDRESS = '1TestAddressDoNotUse';
process.env.XCPFOLIO_PRIVATE_KEY = 'cTestPrivateKeyDoNotUse';

// Suppress console output during tests unless debugging
if (!process.env.DEBUG) {
  global.console = {
    ...console,
    log: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    // Keep error for debugging failed tests
    error: console.error,
  };
}

// Global test timeout
jest.setTimeout(10000);

// Clean up after each test
afterEach(() => {
  jest.clearAllMocks();
});