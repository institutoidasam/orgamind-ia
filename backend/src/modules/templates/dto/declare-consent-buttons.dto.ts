import { createZodDto } from 'nestjs-zod';
import { declareConsentButtonsSchema } from '../../../schemas/contracts/template.schema';

export class DeclareConsentButtonsDto extends createZodDto(
  declareConsentButtonsSchema,
) {}
