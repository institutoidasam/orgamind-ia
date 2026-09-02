import { createZodDto } from 'nestjs-zod';
import { createSegmentSchema } from '../../../schemas/contracts/segment.schema';

export class CreateSegmentDto extends createZodDto(createSegmentSchema) {}
