import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { WebhooksModule } from './webhooks.module';
import { WebhooksController } from './webhooks.controller';

describe('WebhooksModule', () => {
  it('WebhooksModule só registra WebhooksController', () => {
    // Twilio/Zernio/GoZap deixam de ter rota (R5, 404); os arquivos ficam (GC5).
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      WebhooksModule,
    ) as unknown[];
    expect(controllers).toEqual([WebhooksController]);
  });
});
