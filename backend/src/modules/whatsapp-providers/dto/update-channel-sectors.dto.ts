import { createZodDto } from 'nestjs-zod';
import { updateChannelSectorsSchema } from '../../../schemas/contracts/instance.schema';

export class UpdateChannelSectorsDto extends createZodDto(
  updateChannelSectorsSchema,
) {}
