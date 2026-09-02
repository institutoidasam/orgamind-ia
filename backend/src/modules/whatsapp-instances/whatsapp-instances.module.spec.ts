import { describe, it, expect, vi } from 'vitest';
import { buildEvolutionAdminClient } from './whatsapp-instances.module';
import type { EvolutionApiAdapter } from '../whatsapp-providers/adapters/evolution-api.adapter';

// be-whatsapp: EvolutionApiAdapter is wired into the admin client even on a
// Meta deploy, so delete()/restart()/create() would call Evolution logout/
// restart/create against a server that doesn't exist for that tenant. Gate the
// admin client by WHATSAPP_PROVIDER: a no-op client under 'meta'.
describe('buildEvolutionAdminClient', () => {
  function makeAdapter() {
    return {
      adminCreateInstance: vi.fn().mockResolvedValue({ apiKey: '' }),
      adminLogout: vi.fn().mockResolvedValue(undefined),
      adminRestart: vi.fn().mockResolvedValue(undefined),
    } as unknown as EvolutionApiAdapter & {
      adminCreateInstance: ReturnType<typeof vi.fn>;
      adminLogout: ReturnType<typeof vi.fn>;
      adminRestart: ReturnType<typeof vi.fn>;
    };
  }

  describe("provider = 'evolution'", () => {
    it('delegates createInstance/logout/restart to the adapter', async () => {
      const adapter = makeAdapter();
      const client = buildEvolutionAdminClient('evolution', adapter);

      await client.createInstance({ instanceName: 'picoa-x' });
      await client.logout('picoa-x');
      await client.restart('picoa-x');

      expect(adapter.adminCreateInstance).toHaveBeenCalledWith({ instanceName: 'picoa-x' });
      expect(adapter.adminLogout).toHaveBeenCalledWith('picoa-x');
      expect(adapter.adminRestart).toHaveBeenCalledWith('picoa-x');
    });
  });

  describe("provider = 'meta'", () => {
    it('never touches the Evolution adapter (no-op admin client)', async () => {
      const adapter = makeAdapter();
      const client = buildEvolutionAdminClient('meta', adapter);

      const created = await client.createInstance({ instanceName: 'picoa-x' });
      await client.logout('picoa-x');
      await client.restart('picoa-x');

      expect(adapter.adminCreateInstance).not.toHaveBeenCalled();
      expect(adapter.adminLogout).not.toHaveBeenCalled();
      expect(adapter.adminRestart).not.toHaveBeenCalled();
      // create() persists this apiKey; the no-op never produces a real secret.
      expect(created.apiKey).toBe('');
    });
  });
});
