import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ZernioTemplateSyncProcessor } from './zernio-template-sync.processor';
import { TemplatesService } from './templates.service';
import { ZernioTemplateService } from '../whatsapp-providers/zernio-template.service';

describe('ZernioTemplateSyncProcessor', () => {
  let templates: MockProxy<TemplatesService>;
  let zernio: MockProxy<ZernioTemplateService>;
  let proc: ZernioTemplateSyncProcessor;

  beforeEach(() => {
    templates = mockDeep<TemplatesService>();
    zernio = mockDeep<ZernioTemplateService>();
    Object.defineProperty(zernio, 'configured', {
      value: true,
      configurable: true,
    });
    templates.syncFromZernio.mockResolvedValue({ synced: 3, skipped: 0 });
    proc = new ZernioTemplateSyncProcessor(templates, zernio);
  });

  it('reconcilia o catálogo chamando o sync', async () => {
    await proc.process();

    expect(templates.syncFromZernio).toHaveBeenCalledTimes(1);
  });

  // Deploy sem credencial Zernio → nada a reconciliar, e nenhum 401 de hora em
  // hora no log.
  it('sem credencial Zernio → no-op', async () => {
    Object.defineProperty(zernio, 'configured', {
      value: false,
      configurable: true,
    });

    await proc.process();

    expect(templates.syncFromZernio).not.toHaveBeenCalled();
  });

  // Esta é uma REDE DE SEGURANÇA, não o mecanismo principal (o webhook é). Uma
  // falha aqui é registrada pelo BullMQ e a próxima rodada tenta de novo — mas
  // ela não pode passar despercebida.
  it('propaga a falha do sync (o BullMQ registra o tick como falho)', async () => {
    templates.syncFromZernio.mockRejectedValue(new Error('zernio fora do ar'));

    await expect(proc.process()).rejects.toThrow('zernio fora do ar');
  });
});
