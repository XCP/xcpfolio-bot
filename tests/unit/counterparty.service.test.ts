import axios from 'axios';
import { CounterpartyService } from '../../src/services/counterparty';

jest.mock('axios');

describe('CounterpartyService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getOpenOrderAssets', () => {
    it('loads all open orders in pages of 250', async () => {
      const firstPage = Array.from({ length: 250 }, (_, index) => ({
        give_asset_info: { asset_longname: `XCPFOLIO.ASSET${index}` }
      }));
      const secondPage = [
        { give_asset_info: { asset_longname: 'XCPFOLIO.ASSET250' } },
        { give_asset_info: { asset_longname: 'XCPFOLIO.ASSET251' } }
      ];

      (axios as unknown as jest.Mock)
        .mockResolvedValueOnce({ data: { result: firstPage } })
        .mockResolvedValueOnce({ data: { result: secondPage } });

      const service = new CounterpartyService('https://counterparty.test/v2');
      const assets = await service.getOpenOrderAssets('1TestAddress');

      expect(assets.size).toBe(252);
      expect(axios).toHaveBeenCalledTimes(2);
      expect((axios as unknown as jest.Mock).mock.calls[0][0].url).toContain(
        'limit=250&offset=0'
      );
      expect((axios as unknown as jest.Mock).mock.calls[1][0].url).toContain(
        'limit=250&offset=250'
      );
    });
  });
});
