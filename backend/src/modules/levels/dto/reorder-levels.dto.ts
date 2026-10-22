import { createZodDto } from 'nestjs-zod';
import { reorderLevelsSchema } from '../../../schemas/contracts/level.schema';

/** Todos os níveis, cada um uma vez, na ordem desejada (1..100 ids). */
export class ReorderLevelsDto extends createZodDto(reorderLevelsSchema) {}
