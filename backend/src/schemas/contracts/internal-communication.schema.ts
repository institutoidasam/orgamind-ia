import { z } from 'zod';

const sectorIdSchema = z.string().trim().min(1).max(191);
const userIdSchema = z.string().trim().min(1).max(191);
const dueDateSchema = z.iso.date();

export const internalCommunicationKindSchema = z.enum([
  'DEMAND',
  'ANNOUNCEMENT',
]);
export const internalPrioritySchema = z.enum(['NORMAL', 'HIGH', 'URGENT']);
export const internalDemandStatusSchema = z.enum([
  'OPEN',
  'IN_PROGRESS',
  'WAITING',
  'COMPLETED',
]);

const sharedCreateSchema = {
  subject: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(10_000),
  originSectorId: sectorIdSchema,
  destinationSectorId: sectorIdSchema,
  ccSectorIds: z.array(sectorIdSchema).max(49).default([]),
  notifyTeam: z.boolean().default(true),
  notifyAssignee: z.boolean().default(true),
  clientRequestId: z.uuid(),
};

const demandFieldsSchema = z.object({
  ...sharedCreateSchema,
  assigneeId: userIdSchema.optional(),
  priority: internalPrioritySchema.optional(),
  dueDate: dueDateSchema.optional(),
});

export const createInternalCommunicationSchema = demandFieldsSchema
  .extend({ kind: internalCommunicationKindSchema })
  .superRefine((value, ctx) => {
    const targets = [value.destinationSectorId, ...value.ccSectorIds];
    if (new Set(targets).size !== targets.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['ccSectorIds'],
        message: 'Setores destinatários não podem se repetir.',
      });
    }
    if (
      value.kind === 'ANNOUNCEMENT' &&
      (value.assigneeId !== undefined ||
        value.priority !== undefined ||
        value.dueDate !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Comunicado não aceita campos de demanda.',
      });
    }
  });

export const updateDemandSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    status: internalDemandStatusSchema.optional(),
    assigneeId: userIdSchema.nullable().optional(),
    priority: internalPrioritySchema.optional(),
    dueDate: dueDateSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.status === undefined &&
      value.assigneeId === undefined &&
      value.priority === undefined &&
      value.dueDate === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Informe ao menos uma alteração de demanda.',
      });
    }
  });

export const createInternalCommentSchema = z.object({
  message: z.string().trim().min(1).max(10_000),
});

export const internalCommunicationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(160).optional(),
  kind: internalCommunicationKindSchema.optional(),
  status: internalDemandStatusSchema.optional(),
  unassigned: z
    .preprocess((value) => {
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    }, z.boolean())
    .optional(),
  sectorId: sectorIdSchema.optional(),
});

export type CreateInternalCommunication = z.infer<
  typeof createInternalCommunicationSchema
>;
export type UpdateDemand = z.infer<typeof updateDemandSchema>;
export type InternalCommunicationListQuery = z.infer<
  typeof internalCommunicationListQuerySchema
>;
