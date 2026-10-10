import { createZodDto } from 'nestjs-zod';
import {
  createSectorSchema,
  listSectorsQuerySchema,
  membersQuerySchema,
  updateSectorSchema,
} from '../../schemas/contracts/sector.schema';
export class CreateSectorDto extends createZodDto(createSectorSchema) {}
export class UpdateSectorDto extends createZodDto(updateSectorSchema) {}
export class ListSectorsDto extends createZodDto(listSectorsQuerySchema) {}
export class MembersQueryDto extends createZodDto(membersQuerySchema) {}
