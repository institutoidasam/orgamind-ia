import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { Env } from '../../../shared/config/env.schema';
import { QUEUE_NAMES } from '../../queue/queue.constants';

/**
 * Daily check against Meta Graph API `debug_token` endpoint to surface
 * upcoming META_ACCESS_TOKEN expirations. Long-lived tokens report
 * `expires_at: 0` and are logged as informational. Tokens expiring
 * within 7 days are logged at error level so they're picked up by alerts.
 */
@Processor(QUEUE_NAMES.TOKEN_CHECK)
export class CheckTokenExpiryProcessor extends WorkerHost {
  private readonly logger = new Logger(CheckTokenExpiryProcessor.name);

  constructor(private readonly config: ConfigService<Env>) {
    super();
  }

  async process(): Promise<void> {
    const token = this.config.get('META_ACCESS_TOKEN', { infer: true });
    if (!token) {
      this.logger.warn('META_ACCESS_TOKEN not configured — skipping check');
      return;
    }

    try {
      const { data } = await axios.get(
        'https://graph.facebook.com/v22.0/debug_token',
        {
          params: { input_token: token, access_token: token },
          timeout: 10_000,
        },
      );

      const expiresAt = data?.data?.expires_at;
      if (!expiresAt || expiresAt === 0) {
        this.logger.log('Meta token: long-lived (no expiry)');
        return;
      }

      const secondsUntilExpiry = expiresAt - Math.floor(Date.now() / 1000);
      const daysUntilExpiry = Math.floor(secondsUntilExpiry / 86400);

      if (daysUntilExpiry < 7) {
        this.logger.error(
          {
            daysUntilExpiry,
            expiresAt: new Date(expiresAt * 1000).toISOString(),
          },
          'Meta token expires soon',
        );
      } else {
        this.logger.log(`Meta token valid for ${daysUntilExpiry} more days`);
      }
    } catch (err) {
      const e = err as {
        response?: { data?: unknown };
        message?: string;
      };
      this.logger.error(
        { err: e.response?.data ?? e.message },
        'Meta token check failed',
      );
    }
  }
}
