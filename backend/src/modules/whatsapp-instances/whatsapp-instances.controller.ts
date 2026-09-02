import {
  Body, Controller, Delete, Get, Param, Patch, Post, Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { WhatsappInstancesService } from './whatsapp-instances.service';
import { WhatsappInstancesRepository } from './whatsapp-instances.repository';
import { EvolutionApiAdapter } from '../whatsapp-providers/adapters/evolution-api.adapter';
import { describeDisconnectReason } from '../whatsapp-providers/adapters/baileys-disconnect-reason';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateInstanceDto } from './dto/create-instance.dto';
import { UpdateInstanceDto } from './dto/update-instance.dto';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ChannelNotEvolutionError } from '../../shared/errors/domain.error';

type AuthedRequest = Request & { user: { id: string; role: 'ADMIN' | 'OPERATOR' } };

// Baileys behavioral flags that live in Evolution, not our DB. On update they
// must be pushed to Evolution via /settings/set; the DB columns are a
// WRITE-ONLY mirror (nothing reads them back from Evolution — a getSettings
// port existed once and was removed as dead code), so persisting alone leaves
// them inert.
const EVOLUTION_SETTINGS_KEYS = [
  'rejectCall', 'msgCall', 'groupsIgnore', 'alwaysOnline',
  'readMessages', 'readStatus', 'syncFullHistory',
] as const;

@Controller('whatsapp/instances')
export class WhatsappInstancesController {
  constructor(
    private readonly svc: WhatsappInstancesService,
    private readonly repo: WhatsappInstancesRepository,
    private readonly prisma: PrismaService,
    // Direct adapter injection (it's already a provider in this module)
    // avoids the circular dep with WhatsappProvidersModule. For
    // WHATSAPP_PROVIDER=meta there's no QR anyway, so the Evolution-specific
    // coupling here is acceptable.
    private readonly evolution: EvolutionApiAdapter,
  ) {}

  // OPERATOR-readable: powers the connection-status indicator and read-only
  // instance views app-wide. apiKey is omitted at the repo layer, so no secret
  // leaks regardless of role. Soft-deleted (isActive=false) rows must NEVER be
  // listed — for anyone: showing them to ADMINs let deleted instances be picked
  // for campaigns, and every send then failed (prod incident).
  @Get()
  list(@Req() _req: AuthedRequest) {
    return this.svc.list({ activeOnly: true });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.findById(id);
  }

  /**
   * Live connection info for a specific instance — includes qrBase64 /
   * pairingCode when the instance isn't yet paired. The frontend's
   * CreateInstanceDialog polls this while waiting for the user to scan.
   * State === 'open' means paired; QR is dropped and won't be in the
   * response.
   */
  @Roles('ADMIN')
  @Get(':id/qr')
  async qr(@Param('id') id: string) {
    const instance = await this.svc.findById(id);
    if (!instance.evolutionInstanceName) throw new ChannelNotEvolutionError(instance.id);
    // Heal orphan rows (e.g. the seed-created default) whose Evolution instance
    // was never created: provision it + arm the webhook before fetching the QR.
    // Idempotent, so it's safe to call on every poll.
    await this.evolution.ensureProvisioned(instance.evolutionInstanceName);
    const info = await this.evolution.getConnectionInfo(instance.evolutionInstanceName);
    return {
      state: info.state,
      qrBase64: info.qrBase64,
      pairingCode: info.pairingCode,
      disconnectionReasonCode: info.disconnectionReasonCode ?? null,
      disconnectionAt: info.disconnectionAt ?? null,
      // Only surface a "why it disconnected" explanation when NOT connected:
      // Evolution keeps the last disconnectionReasonCode on fetchInstances even
      // after a successful re-pair, so echoing it while state==='open' would
      // show a stale reason under a healthy connection.
      disconnectionReason:
        info.state === 'open'
          ? null
          : describeDisconnectReason(info.disconnectionReasonCode),
    };
  }

  @Roles('ADMIN')
  @Post()
  create(@Body() body: CreateInstanceDto) {
    return this.svc.create({
      name: body.name,
      ownerUserId: body.ownerUserId,
      isDefault: body.isDefault,
    });
  }

  @Roles('ADMIN')
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: UpdateInstanceDto) {
    const { isDefault, ...rest } = body;
    const found = await this.repo.findById(id);
    if (!found) return this.svc.findById(id); // throws InstanceNotFoundError

    if (Object.keys(rest).length > 0) {
      await this.prisma.channel.update({
        where: { id },
        data: rest,
      });
      // Baileys flags are only honored by WhatsApp once pushed to Evolution;
      // the DB write above is a write-only mirror that nothing reads back.
      const settings: Record<string, unknown> = {};
      for (const key of EVOLUTION_SETTINGS_KEYS) {
        if (key in rest) settings[key] = (rest as Record<string, unknown>)[key];
      }
      if (Object.keys(settings).length > 0) {
        if (!found.evolutionInstanceName) throw new ChannelNotEvolutionError(found.id);
        await this.evolution.setSettings(settings, found.evolutionInstanceName);
      }
    }
    if (isDefault === true) {
      await this.svc.setDefault(id);
    }
    return this.svc.findById(id);
  }

  @Roles('ADMIN')
  @Post(':id/restart')
  restart(@Param('id') id: string) {
    return this.svc.restart(id);
  }

  @Roles('ADMIN')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.delete(id);
  }
}
