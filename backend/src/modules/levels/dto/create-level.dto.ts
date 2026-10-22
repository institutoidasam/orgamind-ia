import { createZodDto } from 'nestjs-zod';
import { createLevelSchema } from '../../../schemas/contracts/level.schema';

export class CreateLevelDto extends createZodDto(createLevelSchema) {}
