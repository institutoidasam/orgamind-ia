import { z } from "zod";

const roleSchema = z.enum(["ADMIN", "SUPERVISOR", "OPERATOR", "VIEWER"]);
const sectorSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  isActive: z.boolean().default(true),
});

/** C1: o número efetivo da área (`null` = "Sem número"). */
export const sectorChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  phoneE164: z.string().nullable(),
});

const managerSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().email().nullable(),
});

export const sectorSchema = sectorSummarySchema.extend({
  description: z.string().nullable(),
  managerId: z.string().nullable().optional().default(null),
  manager: managerSchema.nullable().optional().default(null),
  memberCount: z.number().int().nonnegative().default(0),
  channel: sectorChannelSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** E4: uso do setor, espelho tolerante da API (contagens ausentes valem 0). */
export const sectorUsageSchema = z.object({
  people: z.number().int().nonnegative().default(0),
  exceptions: z.number().int().nonnegative().default(0),
  scheduled: z.number().int().nonnegative().default(0),
  inactivePeople: z.number().int().nonnegative().default(0),
});

export const sectorDetailSchema = sectorSchema.extend({
  usage: sectorUsageSchema.nullish(),
  members: z
    .array(
      z.object({
        id: z.string(),
        email: z.string().email().nullable(),
        name: z.string().nullable(),
        role: roleSchema,
        isActive: z.boolean().default(true),
      }),
    )
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

export type Sector = z.infer<typeof sectorSchema>;
export type SectorChannel = z.infer<typeof sectorChannelSchema>;
export type SectorDetail = z.infer<typeof sectorDetailSchema>;
export type SectorUsage = z.infer<typeof sectorUsageSchema>;
export type SectorInput = z.output<typeof sectorInputSchema>;
export type InternalRole = z.infer<typeof roleSchema>;
export const INTERNAL_ROLES = roleSchema.options;
