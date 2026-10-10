import { z } from 'zod';

const e164Schema = z
  .string()
  .trim()
  .refine((value) => /^[\d+\s().-]+$/.test(value), 'phone must be E.164')
  .transform((value) => value.replace(/[\s().-]/g, ''))
  .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, 'phone must be E.164'));

const numberInputShape = {
  name: z.string().trim().min(1).max(120),
  phone: e164Schema,
  provider: z.enum(['META', 'EVOLUTION', 'OTHER']),
  sectorId: z.string().min(1),
  routeToSector: z.boolean(),
  channelId: z.string().min(1).nullable().optional(),
} as const;

export const createInternalNumberSchema = z.object(numberInputShape).strict();
export const updateInternalNumberSchema = z
  .object({
    ...numberInputShape,
    name: numberInputShape.name.optional(),
    phone: numberInputShape.phone.optional(),
    provider: numberInputShape.provider.optional(),
    sectorId: numberInputShape.sectorId.optional(),
    routeToSector: numberInputShape.routeToSector.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'at least one field is required',
  );

export const listInternalNumbersQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type CreateInternalNumber = z.infer<typeof createInternalNumberSchema>;
export type UpdateInternalNumber = z.infer<typeof updateInternalNumberSchema>;
