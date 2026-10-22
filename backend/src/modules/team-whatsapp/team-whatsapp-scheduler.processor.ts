import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'crypto';
import { QUEUE_NAMES } from '../queue/queue.constants';
import {
  AUDIT_CLS_KEY,
  type AuditContext,
} from '../../shared/audit/audit.service';
import { TeamWhatsappScheduleService } from './team-whatsapp-schedule.service';

/**
 * Tick de minuto do envio agendado da equipe (T9), agendado pelo worker.ts como
 * job repetível. `concurrency: 1` só evita ticks sobrepostos neste worker; quem
 * garante disparo único (inclusive contra o cancelamento) é o claim condicional
 * do repositório. Cada tick roda em CLS com correlationId próprio, como o
 * scheduler de campanhas, para a auditoria do disparo sair amarrada ao tick.
 */
@Processor(QUEUE_NAMES.TEAM_WHATSAPP_SCHEDULER, { concurrency: 1 })
export class TeamWhatsappSchedulerProcessor extends WorkerHost {
  constructor(
    private readonly schedule: TeamWhatsappScheduleService,
    private readonly cls: ClsService,
  ) {
    super();
  }

  async process(): Promise<void> {
    return this.cls.run(async () => {
      this.cls.set<AuditContext>(AUDIT_CLS_KEY, {
        correlationId: `team-sched-${randomUUID()}`,
      });
      await this.schedule.fireDue(new Date());
    });
  }
}
