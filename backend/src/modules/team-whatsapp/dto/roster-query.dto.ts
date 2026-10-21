import { createZodDto } from 'nestjs-zod';
import { teamRosterQuerySchema } from '../../../schemas/contracts/team-whatsapp.schema';

export class RosterQueryDto extends createZodDto(teamRosterQuerySchema) {}
