import { createZodDto } from 'nestjs-zod';
import { createChannelSchema } from '../../../schemas/contracts/instance.schema';

export class CreateChannelDto extends createZodDto(createChannelSchema) {}
