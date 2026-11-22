import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ChatModule } from './chat.module';
import { ZernioInboxSyncController } from './zernio-inbox-sync.controller';

describe('ChatModule', () => {
  it('ChatModule não registra ZernioInboxSyncController', () => {
    // Sem POST/GET /whatsapp/channels/:id/sync-inbox (R5); o arquivo fica (GC5).
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      ChatModule,
    ) as unknown[];
    expect(controllers).not.toContain(ZernioInboxSyncController);
  });
});
