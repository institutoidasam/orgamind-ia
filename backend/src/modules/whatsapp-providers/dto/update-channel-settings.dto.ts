import { createZodDto } from 'nestjs-zod';
import { updateChannelSettingsSchema } from '../../../schemas/contracts/instance.schema';

export class UpdateChannelSettingsDto extends createZodDto(
  updateChannelSettingsSchema,
) {}
