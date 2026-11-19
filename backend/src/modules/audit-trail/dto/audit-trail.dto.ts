import { createZodDto } from 'nestjs-zod';
import {
  auditTrailQuerySchema,
  personHistoryQuerySchema,
} from '../../../schemas/contracts/audit-trail.schema';

/** `?q&from&to&category&page&pageSize` da consulta geral (C7). */
export class AuditTrailQueryDto extends createZodDto(auditTrailQuerySchema) {}

/** `?page&pageSize` do histórico de uma pessoa (C7). */
export class PersonHistoryQueryDto extends createZodDto(
  personHistoryQuerySchema,
) {}
