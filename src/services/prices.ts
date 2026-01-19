import * as fs from 'fs';
import * as path from 'path';

export interface AssetPrice {
  asset: string;
  price: number;
}

/**
 * Load prices from a JSON file
 * Expected format: [{ "asset": "NAME", "price": 5 }, ...]
 * Or: { "NAME": 5, "NAME2": 10, ... }
 */
export function loadPricesFromJson(filePath: string): Map<string, number> {
  const prices = new Map<string, number>();

  if (!fs.existsSync(filePath)) {
    console.warn(`[Prices] File not found: ${filePath}`);
    return prices;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);

    if (Array.isArray(data)) {
      // Array format: [{ asset, price }, ...]
      for (const item of data) {
        if (item.asset && typeof item.price === 'number' && item.price > 0) {
          prices.set(item.asset, item.price);
        }
      }
    } else if (typeof data === 'object') {
      // Object format: { ASSET: price, ... }
      for (const [asset, price] of Object.entries(data)) {
        if (typeof price === 'number' && price > 0) {
          prices.set(asset, price);
        }
      }
    }

    console.log(`[Prices] Loaded ${prices.size} prices from ${filePath}`);
  } catch (error) {
    console.error(`[Prices] Error loading ${filePath}:`, error);
  }

  return prices;
}

/**
 * Load prices from CSV file
 * Expected format: asset,length,category,keyword,first issued,ask price
 */
export function loadPricesFromCsv(filePath: string): Map<string, number> {
  const prices = new Map<string, number>();

  if (!fs.existsSync(filePath)) {
    console.warn(`[Prices] CSV not found: ${filePath}`);
    return prices;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    // Skip header
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length >= 6) {
        const asset = parts[0].trim();
        const price = parseFloat(parts[5].trim()); // "ask price" column
        if (asset && !isNaN(price) && price > 0) {
          prices.set(asset, price);
        }
      }
    }

    console.log(`[Prices] Loaded ${prices.size} prices from CSV ${filePath}`);
  } catch (error) {
    console.error(`[Prices] Error loading CSV ${filePath}:`, error);
  }

  return prices;
}

/**
 * Load prices from environment variable
 * Format: ASSET1:PRICE1,ASSET2:PRICE2,...
 */
export function loadPricesFromEnv(envVar: string = 'ASSET_PRICES'): Map<string, number> {
  const prices = new Map<string, number>();
  const value = process.env[envVar];

  if (!value) {
    return prices;
  }

  try {
    const pairs = value.split(',');
    for (const pair of pairs) {
      const [asset, priceStr] = pair.split(':');
      const price = parseFloat(priceStr);
      if (asset && !isNaN(price) && price > 0) {
        prices.set(asset.trim(), price);
      }
    }
    console.log(`[Prices] Loaded ${prices.size} prices from env ${envVar}`);
  } catch (error) {
    console.error(`[Prices] Error parsing ${envVar}:`, error);
  }

  return prices;
}

/**
 * Load prices from best available source
 * Priority: 1) JSON file, 2) CSV file, 3) Parent dir CSV (dev), 4) Environment variable
 */
export function loadPrices(options?: {
  jsonPath?: string;
  csvPath?: string;
  envVar?: string;
}): Map<string, number> {
  const cwd = process.cwd();
  const opts = {
    jsonPath: options?.jsonPath || path.join(cwd, 'prices.json'),
    csvPath: options?.csvPath || path.join(cwd, 'subassets_priced.csv'),
    parentCsvPath: path.join(cwd, '..', 'subassets_priced.csv'), // For dev: ../subassets_priced.csv
    envVar: options?.envVar || 'ASSET_PRICES',
  };

  // Try JSON first (best for production/Vercel)
  let prices = loadPricesFromJson(opts.jsonPath);
  if (prices.size > 0) return prices;

  // Try CSV in bot directory
  prices = loadPricesFromCsv(opts.csvPath);
  if (prices.size > 0) return prices;

  // Try parent directory CSV (for local dev when running from bot/)
  prices = loadPricesFromCsv(opts.parentCsvPath);
  if (prices.size > 0) return prices;

  // Try environment variable
  prices = loadPricesFromEnv(opts.envVar);
  if (prices.size > 0) return prices;

  console.warn('[Prices] No prices loaded from any source');
  return prices;
}
