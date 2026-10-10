import { z } from "zod";

const roleSchema = z.enum(["ADMIN", "SUPERVISOR", "OPERATOR", "VIEWER"]);
const sectorSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  isActive: z.boolean().default(true),
});

const managerSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().email(),
});

export const sectorSchema = sectorSummarySchema.extend({
  description: z.string().nullable(),
  managerId: z.string().nullable().optional().default(null),
  manager: managerSchema.nullable().optional().default(null),
  memberCount: z.number().int().nonnegative().default(0),
  numberCount: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const sectorDetailSchema = sectorSchema.extend({
  members: z
    .array(
      z.object({
        id: z.string(),
        email: z.string().email(),
        name: z.string().nullable(),
        role: roleSchema,
        isActive: z.boolean().default(true),
      }),
    )
    .default([]),
  numbers: z
    .array(z.object({ id: z.string(), name: z.string(), phone: z.string() }))
    .default([]),
});

export const sectorInputSchema = z.object({
  name: z.string().trim().min(1, "Informe o nome").max(120),
  code: z
    .string()
    .trim()
    .min(1, "Informe a sigla")
    .max(8)
    .transform((value) => value.toUpperCase()),
  description: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value) => value || undefined),
  managerId: z.string().nullable().optional(),
  isActive: z.boolean().default(true),
});

export const sectorListSchema = z.object({
  items: z.array(sectorSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export const internalNumberSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string(),
  provider: z.enum(["META", "EVOLUTION", "OTHER"]),
  sectorId: z.string().nullable().optional().default(null),
  sector: sectorSummarySchema.nullable(),
  routeToSector: z.boolean().default(false),
  channelId: z.string().nullable().optional().default(null),
  configurationStatus: z
    .enum(["UNCONFIGURED", "CONFIGURED"])
    .default("UNCONFIGURED"),
  routingStatus: z.literal("PENDING").optional().default("PENDING"),
  channel: z
    .object({
      id: z.string(),
      name: z.string(),
      provider: z.string(),
      isActive: z.boolean(),
      ownerUserId: z.string().nullable(),
    })
    .nullable()
    .optional()
    .default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const internalNumberInputSchema = z.object({
  name: z.string().trim().min(1, "Informe o nome").max(120),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/, "Use número no formato E.164"),
  provider: z.enum(["META", "EVOLUTION", "OTHER"]),
  sectorId: z.string().min(1, "Selecione o setor"),
  routeToSector: z.boolean(),
  channelId: z.string().nullable().optional(),
});

export const internalNumberListSchema = z.object({
  items: z.array(internalNumberSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export type Sector = z.infer<typeof sectorSchema>;
export type SectorDetail = z.infer<typeof sectorDetailSchema>;
export type SectorInput = z.output<typeof sectorInputSchema>;
export type InternalNumber = z.infer<typeof internalNumberSchema>;
export type InternalNumberInput = z.output<typeof internalNumberInputSchema>;
export type InternalRole = z.infer<typeof roleSchema>;
export const INTERNAL_ROLES = roleSchema.options;
