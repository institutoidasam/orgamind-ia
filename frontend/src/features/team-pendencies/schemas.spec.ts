import { describe, expect, it } from "vitest";
import {
  pendencyHandlersSchema,
  teamPendencyCountSchema,
  teamPendencyItemSchema,
  teamPendencyListSchema,
} from "./schemas";

/** O item completo de CK2, como o servidor o devolve. */
const full = {
  id: "r1",
  dispatchId: "d1",
  person: {
    name: "Pessoa A",
    sectorId: "s1",
    sectorName: "Setor 1",
    shiftName: "Manhã",
    phoneE164: "+5592991110001",
    hasPhone: true,
    phoneMasked: null,
  },
  alert: {
    text: "Parada de linha",
    authorName: "Gestor S1",
    sentAt: "2026-11-21T13:00:00.000Z",
    ackDeadlineAt: "2026-11-21T13:30:00.000Z",
  },
  group: "replied",
  situation: "OVERDUE",
  handler: { id: "u1", name: "Operador B", state: "active" },
  assignedAt: "2026-11-21T13:10:00.000Z",
  dueAt: "2026-11-21T14:10:00.000Z",
  closure: {
    byId: "u2",
    byName: "Gestor S1",
    at: "2026-11-21T14:00:00.000Z",
    reason: "Sem retorno",
  },
  ack: { kind: "MANUAL", at: "2026-11-21T14:05:00.000Z" },
  lastReply: { text: null, media: "audio", at: "2026-11-21T13:20:00.000Z" },
  notes: [
    {
      id: "n1",
      kind: "CONTACT",
      authorName: "Operador B",
      at: "2026-11-21T13:15:00.000Z",
      text: "Liguei",
    },
  ],
  conversationId: "c1",
  canViewDispatch: true,
};

describe("schemas da pendência", () => {
  it("aceita o item completo de CK2", () => {
    expect(teamPendencyItemSchema.parse(full)).toEqual(full);
  });

  it("tolera campos novos ausentes (closure, notes, lastReply, conversationId)", () => {
    const { closure, notes, lastReply, conversationId, ...old } = full;
    void [closure, notes, lastReply, conversationId];
    const item = teamPendencyItemSchema.parse(old);
    expect(item.closure).toBeNull();
    expect(item.lastReply).toBeNull();
    expect(item.conversationId).toBeNull();
    expect(item.notes).toEqual([]);
  });

  it("flags ausentes leem do lado seguro (sem telefone, sem acesso ao envio)", () => {
    const { hasPhone, ...person } = full.person;
    const { canViewDispatch, ...rest } = full;
    void [hasPhone, canViewDispatch];
    const item = teamPendencyItemSchema.parse({ ...rest, person });
    expect(item.person.hasPhone).toBe(false);
    expect(item.canViewDispatch).toBe(false);
  });

  it("lista, contador e destinos: listas e flag ausentes leem como vazio e falso", () => {
    const list = teamPendencyListSchema.parse({
      items: [full],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(list.sectors).toEqual([]);
    expect(list.truncated).toBe(false);
    expect(teamPendencyCountSchema.parse({ unassignedOverdue: 3 })).toEqual({
      unassignedOverdue: 3,
    });
    expect(pendencyHandlersSchema.parse({}).items).toEqual([]);
  });
});
