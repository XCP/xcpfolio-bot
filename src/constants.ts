/**
 * Application-wide constants
 */

// Time constants (in milliseconds)
export const TIME = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
} as const;

// Block time constants
export const BLOCKS = {
  PER_HOUR: 6,  // ~10 minutes per block
  PER_DAY: 144,
} as const;

// Maintenance retry strategy constants
export const MAINTENANCE_RETRY_STRATEGY = {
  // Retry thresholds
  QUICK_ATTEMPTS: 3,        // First 3: retry quickly
  MODERATE_ATTEMPTS: 5,     // Attempts 4-5: moderate backoff
  EXTENDED_ATTEMPTS: 10,    // Attempts 6-10: longer backoff
  MAX_ATTEMPTS: 10,         // Max retries per asset per run

  // Backoff delays (ms)
  QUICK_BACKOFF: 5 * 1000,       // 5 seconds
  MODERATE_BACKOFF: 15 * 1000,   // 15 seconds
  EXTENDED_BACKOFF: 30 * 1000,   // 30 seconds
  MAX_BACKOFF: 60 * 1000,        // 60 seconds

  // Active order tracking
  STALE_ORDER_AGE: 2 * 60 * 60 * 1000,  // 2 hours - consider order stale/dropped
  MEMPOOL_CHECK_DELAY: 2000,            // 2 seconds to verify mempool

  // Alert thresholds
  ALERT_AT_5: 5,
  ALERT_AT_10: 10,
} as const;

// Retry strategy constants
export const RETRY_STRATEGY = {
  // Pre-broadcast retries (compose/sign failures)
  PRE_BROADCAST: {
    QUICK_ATTEMPTS: 10,        // First 10: retry quickly
    MODERATE_ATTEMPTS: 25,     // Next 15: moderate backoff
    EXTENDED_ATTEMPTS: 50,     // Next 25: longer backoff
    MAX_ATTEMPTS: 100,         // Absolute max
    
    QUICK_BACKOFF: 5 * 1000,       // 5 seconds
    MODERATE_BACKOFF: 30 * 1000,   // 30 seconds
    EXTENDED_BACKOFF: 60 * 1000,   // 1 minute
    HOURLY_BACKOFF: 5 * 60 * 1000, // 5 minutes
    
    RESET_AFTER: 60 * 60 * 1000,   // Reset after 1 hour
    
    // Alert thresholds
    ALERT_AT_10: 10,
    ALERT_AT_25: 25,
    ALERT_AT_50: 50,
  },
  
  // RBF strategy (BIP-125 compliant)
  RBF: {
    FIRST_THRESHOLD_BLOCKS: 3,     // Start RBF after 3 blocks (~30 min)
    QUICK_RETRY_BLOCKS: 2,          // First 3 RBFs: every 2 blocks
    MODERATE_RETRY_BLOCKS: 3,       // RBFs 4-5: every 3 blocks
    SLOW_RETRY_BLOCKS: 6,           // RBFs 6+: every 6 blocks
    
    MAX_ATTEMPTS: 10,               // Maximum RBF attempts (no Bitcoin limit, but 10 is reasonable)
    QUICK_ATTEMPTS: 3,              // First 3 attempts are quick
    MODERATE_ATTEMPTS: 5,           // Attempts 4-5 are moderate
    
    // Fee multipliers (BIP-125 requires higher fee rate + absolute fee)
    FIRST_MULTIPLIER: 1.25,         // 25% bump (well above minimum requirement)
    DROPPED_MULTIPLIER: 2.0,        // 100% bump for dropped tx
    EARLY_MULTIPLIER: 1.5,          // 50% bump
    MIDDLE_MULTIPLIER: 2.0,         // 100% bump
    LATE_MULTIPLIER: 2.5,           // 150% bump
    MARKET_PREMIUM_MULTIPLIER: 1.5,
    MARKET_BUFFER_MULTIPLIER: 1.1, // 10% above market (ensures higher than current mempool)
    
    // Bitcoin network limits
    MIN_RELAY_FEE: 1,               // Minimum relay fee (sat/vB)
    MIN_FEE_INCREMENT: 1,           // Minimum fee rate increment for RBF (sat/vB)
    ABSOLUTE_MIN_FEE: 1000,         // Minimum absolute fee (sats) for any transaction
    
    MARKET_PREMIUM_BLOCKS: 12,     // Apply premium after 12 blocks (~2 hours)
    MAX_FEE_RATE: 500,              // Maximum fee rate cap (sat/vB) - protective limit
    
    // RBF signaling
    SEQUENCE_RBF_ENABLED: 0xfffffffd,  // Signals RBF-enabled (BIP-125)
    SEQUENCE_FINAL: 0xffffffff,        // Signals finalized (no RBF)
  },
} as const;

// Transaction limits
export const TX_LIMITS = {
  MAX_MEMPOOL_TXS: 25,             // Bitcoin mempool limit
  COMPOSE_COOLDOWN: 10000,         // 10 seconds between compose calls
  MEMPOOL_CHECK_DELAY: 2000,       // 2 seconds to check mempool after broadcast
  
  // Fee limits (safety feature to prevent excessive spending)
  MAX_TOTAL_FEE_SATS: 10000,       // 0.0001 BTC = 10,000 sats hard ceiling per transaction
  MAX_FEE_RATE_FOR_NEW_TX: 100,    // Max 100 sat/vB for new transactions (wait if higher)
  ESTIMATED_TX_VSIZE: 250,          // Estimated vsize for fee calculations (~250 vbytes for typical transfer)
} as const;

// API configuration
export const API_CONFIG = {
  COUNTERPARTY: {
    DEFAULT_URL: 'https://api.counterparty.io:4000/v2',
    DEFAULT_LIMIT: 100,
  },
  MEMPOOL: {
    DEFAULT_URL: 'https://mempool.space/api',
  },
  BLOCKSTREAM: {
    DEFAULT_URL: 'https://blockstream.info/api',
  },
} as const;

// Asset configuration
export const ASSET_CONFIG = {
  XCPFOLIO_PREFIX: 'XCPFOLIO.',
  XCP: 'XCP',
} as const;

// P2PKH transaction size estimates (in bytes)
export const TX_SIZE = {
  INPUT: 148,      // ~148 bytes per P2PKH input
  OUTPUT: 34,      // ~34 bytes per P2PKH output
  OVERHEAD: 10,    // ~10 bytes overhead
} as const;

// Notification levels
export const NOTIFICATION_LEVEL = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical',
} as const;

// Status messages
export const STATUS = {
  PROCESSING: 'processing',
  IDLE: 'idle',
  FILLED: 'filled',
  CONFIRMED: 'confirmed',
} as const;

// File paths
export const PATHS = {
  STATE_FILE: '.fulfillment-state.json',
} as const;