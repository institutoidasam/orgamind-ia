import { z } from 'zod';

const actorSchema = z.object({
  id: z.string(),
  name: z.string().nullable().catch(null),
  email: z.string().nullable().catch(null),
});

export const sectorSchema = z.object({ id: z.string(), name: z.string(), code: z.string() });
export const communicationKindSchema = z.enum(['DEMAND', 'ANNOUNCEMENT']);
export const demandStatusSchema = z.enum(['OPEN', 'IN_PROGRESS', 'WAITING', 'COMPLETED']);
export const prioritySchema = z.enum(['NORMAL', 'HIGH', 'URGENT']);

export const communicationEventSchema = z.object({
  id: z.string(), kind: z.string(), message: z.string().nullable().optional(),
  author: actorSchema.nullable().optional(), createdAt: z.string(),
});

export const communicationDetailSchema = z.object({
  id: z.string(), reference: z.string(), kind: communicationKindSchema, subject: z.string(), message: z.string(),
  originSector: sectorSchema, destinationSector: sectorSchema, ccSectors: z.array(sectorSchema),
  author: actorSchema.nullable(), assignee: actorSchema.nullable(), priority: prioritySchema.nullable(),
  dueDate: z.string().nullable(), status: demandStatusSchema.nullable(), version: z.number().int(),
  notifyTeam: z.boolean(), notifyAssignee: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
  completedAt: z.string().nullable(), isUnread: z.boolean(), events: z.array(communicationEventSchema),
});

export const communicationPageSchema = z.object({
  items: z.array(communicationDetailSchema), total: z.number(), page: z.number(), pageSize: z.number(),
});

export const eligibleMemberSchema = actorSchema.extend({
  role: z.enum(['ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER']), sectorId: z.string().nullable(), isActive: z.boolean(),
});

const recentEventSchema = z.object({
  id: z.string(), kind: z.string(), message: z.string().nullable().optional(), createdAt: z.string(),
  actor: actorSchema.nullable().optional(),
  communication: z.object({ id: z.string(), reference: z.string(), subject: z.string(), kind: communicationKindSchema.optional() }),
});

export const internalDashboardSchema = z.object({
  needsAction: z.number(), nearDeadline: z.number(), waitingOthers: z.number(), unassigned: z.number(),
  completedThisWeek: z.number(), priorities: z.array(communicationDetailSchema),
  recentUpdates: z.array(recentEventSchema), sector: z.union([z.string(), sectorSchema]).nullable(),
});

export type CommunicationDetail = z.infer<typeof communicationDetailSchema>;
export type CommunicationPage = z.infer<typeof communicationPageSchema>;
export type InternalDashboard = z.infer<typeof internalDashboardSchema>;
export type CommunicationKind = z.infer<typeof communicationKindSchema>;
export type DemandStatus = z.infer<typeof demandStatusSchema>;
export type Priority = z.infer<typeof prioritySchema>;
