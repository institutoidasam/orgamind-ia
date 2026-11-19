import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { TemplatesModule } from './templates.module';
import { TemplateApprovalSyncProcessor } from './template-approval-sync.processor';
import { ZernioTemplateSyncProcessor } from './zernio-template-sync.processor';

describe('TemplatesModule', () => {
  const providers = Reflect.getMetadata(
    'providers',
    TemplatesModule,
  ) as unknown[];

  it('TemplatesModule não registra ZernioTemplateSyncProcessor', () => {
    expect(providers).not.toContain(ZernioTemplateSyncProcessor);
  });

  it('mantém o TemplateApprovalSyncProcessor (só perde o cron, no worker)', () => {
    expect(providers).toContain(TemplateApprovalSyncProcessor);
  });
});
