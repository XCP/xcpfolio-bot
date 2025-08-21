/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/types.ts',
    '!src/constants.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@noble/secp256k1$': '<rootDir>/tests/mocks/crypto-mocks.ts',
    '^@scure/btc-signer$': '<rootDir>/tests/mocks/crypto-mocks.ts',
    '^@scure/base$': '<rootDir>/tests/mocks/crypto-mocks.ts'
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@noble|@scure)/)'
  ],
  globals: {
    'ts-jest': {
      tsconfig: {
        target: 'ES2022',
        module: 'commonjs',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true
      }
    }
  },
  testTimeout: 10000,
  verbose: true
};