import axios from 'axios';
import { BitcoinService } from '../../src/services/bitcoin';
import { deliveryState, freshCounterpartyUrl } from '../../src/services/chain-read';

jest.mock('axios');
const mocked = jest.mocked(axios);
const hash = 'a'.repeat(64);

test('a relocated delivery stays confirmed until its new confirmation reaches the watch depth', () => {
  const status = { confirmed: true, block_height: 100, block_hash: hash };
  expect(deliveryState(status, hash, 110)).toBe('confirmed');
  expect(deliveryState(status, hash, 111)).toBe('final');
  expect(deliveryState(status, 'b'.repeat(64), 111)).toBe('orphaned');
  expect(deliveryState(status, null, 111)).toBe('unknown');
  expect(deliveryState(status, hash, 99)).toBe('unknown');
});

test('only an explicit 404 is absence; a 503 preserves delivery state', async () => {
  mocked.isAxiosError.mockReturnValue(true);
  mocked.get.mockRejectedValueOnce({ response: { status: 404 } });
  expect(await new BitcoinService().getConfirmationStatus(hash)).toBeNull();
  const unavailable = { response: { status: 503 } };
  mocked.get.mockRejectedValueOnce(unavailable);
  await expect(new BitcoinService().getConfirmationStatus(hash)).rejects.toBe(unavailable);
});

test('fresh cache keys preserve verbose and pagination semantics', () => {
  const path = 'https://core.test/v2/events?cursor=17&limit=500&verbose=true';
  const first = new URL(freshCounterpartyUrl(path));
  const second = new URL(freshCounterpartyUrl(path));
  expect(first.href).not.toBe(second.href);
  expect(second.searchParams.get('cursor')).toBe('17');
  expect(second.searchParams.get('limit')).toBe('500');
  expect(second.searchParams.get('verbose')).toBe('true');
});
