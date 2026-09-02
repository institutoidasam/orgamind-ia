import { createZodDto } from 'nestjs-zod';
import { updateOrganizationSchema } from '../../../schemas/contracts/organization.schema';

export class UpdateOrganizationDto extends createZodDto(
  updateOrganizationSchema,
) {}
