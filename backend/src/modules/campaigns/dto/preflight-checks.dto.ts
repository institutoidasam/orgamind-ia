import { createZodDto } from 'nestjs-zod';
import { preflightChecksSchema } from '../../../schemas/contracts/campaign.schema';

export class PreflightChecksDto extends createZodDto(preflightChecksSchema) {}
