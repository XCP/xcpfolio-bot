import { randomUUID } from 'node:crypto';

export function freshCounterpartyUrl(input: string): string {
  const url = new URL(input);
  const verbose = url.searchParams.get('verbose') ?? 'false';
  url.searchParams.delete('verbose');
  url.searchParams.append('verbose', verbose);
  url.searchParams.append('verbose', randomUUID());
  return url.href;
}

export interface DeliveryWatch { txid: string; blockHeight?: number; blockHash?: string }
export interface ConfirmationStatus { confirmed: boolean; block_height?: number; block_hash?: string }

/** A confirmation is an identity, not merely a height. Provider failures throw
 * before this function; null means an explicit transaction-not-found response. */
export function deliveryState(status: ConfirmationStatus | null, canonicalHash: string | null, tip: number):
  'missing' | 'pending' | 'unknown' | 'orphaned' | 'confirmed' | 'final' {
  if (status === null) return 'missing';
  if (!status.confirmed) return 'pending';
  if (!Number.isSafeInteger(status.block_height) || status.block_height! < 0 ||
      !/^[a-f0-9]{64}$/.test(status.block_hash ?? '') || canonicalHash === null || tip < status.block_height!) return 'unknown';
  if (canonicalHash !== status.block_hash) return 'orphaned';
  return tip - status.block_height! + 1 >= 12 ? 'final' : 'confirmed';
}
