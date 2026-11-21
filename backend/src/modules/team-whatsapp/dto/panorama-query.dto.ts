import { createZodDto } from 'nestjs-zod';
import { teamPanoramaQuerySchema } from '../../../schemas/contracts/team-panorama.schema';

/** `date` obrigatória, com o mesmo `civilDateSchema` do roster (DJ1). */
export class PanoramaQueryDto extends createZodDto(teamPanoramaQuerySchema) {}
