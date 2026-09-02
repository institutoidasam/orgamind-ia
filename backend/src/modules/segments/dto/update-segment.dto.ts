import { createZodDto } from 'nestjs-zod';
import { updateSegmentSchema } from '../../../schemas/contracts/segment.schema';

export class UpdateSegmentDto extends createZodDto(updateSegmentSchema) {}
