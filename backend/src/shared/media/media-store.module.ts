import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { MEDIA_STORE } from './media-store.port';
import { LocalDiskMediaStore } from './local-disk-media-store';

const provider: Provider = {
  provide: MEDIA_STORE,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env>) =>
    new LocalDiskMediaStore(config.get('MEDIA_DIR', { infer: true }) ?? '/data/media'),
};

@Global()
@Module({
  imports: [ConfigModule],
  providers: [provider],
  exports: [MEDIA_STORE],
})
export class MediaStoreModule {}
