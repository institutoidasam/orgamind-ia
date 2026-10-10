import { describe, expect, it } from 'vitest';
import { communicationDetailSchema, internalDashboardSchema } from './schemas';

describe('schemas de comunicação interna', () => {
  it('aceita dados reais do detalhe, inclusive autor preservado no snapshot', () => {
    const detail = communicationDetailSchema.parse({
      id: 'c1', reference: 'DM-000001', kind: 'DEMAND', subject: 'Validar lote',
      message: 'Por favor, validar.', originSector: { id: 'a', name: 'Produção', code: 'PRO' },
      destinationSector: { id: 'b', name: 'Qualidade', code: 'QLD' }, ccSectors: [],
      author: { id: 'u1', name: 'Ana', email: 'ana@gbr.test' }, assignee: null,
      priority: 'HIGH', dueDate: '2026-10-11', status: 'OPEN', version: 0,
      notifyTeam: true, notifyAssignee: true, createdAt: '2026-10-10T10:00:00.000Z',
      updatedAt: '2026-10-10T10:00:00.000Z', completedAt: null, isUnread: true, events: [],
    });
    expect(detail.author.name).toBe('Ana');
    expect(detail.assignee).toBeNull();
  });

  it('normaliza o setor nulo do dashboard durante a transição do backend', () => {
    expect(internalDashboardSchema.parse({
      needsAction: 1, nearDeadline: 0, waitingOthers: 2, unassigned: 1,
      completedThisWeek: 3, priorities: [], recentUpdates: [], sector: null,
    }).sector).toBeNull();
  });
});
