import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'crypto';
import { QUEUE_NAMES } from '../queue/queue.constants';
import {
  AUDIT_CLS_KEY,
  type AuditContext,
} from '../../shared/audit/audit.service';
import { TeamStuckReconcilerService } from './team-stuck-reconciler.service';

/**
 * Ciclo do verificador de presos (Lote H, DH4), agendado pelo worker.ts como
 * repetível de 5 min. Registrado SÓ no WorkerModule (um @Processor duplicado
 * derruba o worker). `concurrency: 1` evita dois ciclos sobrepostos neste
 * worker; quem garante que um envio vivo não é tocado é a consulta do job e a
 * troca condicional, por candidato. É o único que lê o relógio: o serviço
 * recebe `now`. Cada ciclo roda em CLS com correlationId próprio, como o tick
 * do agendado, para as trilhas saírem amarradas ao ciclo.
 */
@Processor(QUEUE_NAMES.TEAM_WHATSAPP_STUCK_RECONCILER, { concurrency: 1 })
export class TeamWhatsappStuckProcessor extends WorkerHost {
  constructor(
    private readonly reconciler: TeamStuckReconcilerService,
    private readonly cls: ClsService,
  ) {
    super();
  }

  async process(): Promise<void> {
    return this.cls.run(async () => {
      this.cls.set<AuditContext>(AUDIT_CLS_KEY, {
        correlationId: `team-stuck-${randomUUID()}`,
      });
      await this.reconciler.reconcile(new Date());
    });
  }
}
