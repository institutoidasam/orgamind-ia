import { createZodDto } from 'nestjs-zod';
import { redispatchCampaignSchema } from '../../../schemas/contracts/campaign.schema';

/** "Disparar novamente": corpo opcional — default resendToAll=false. */
export class RedispatchCampaignDto extends createZodDto(
  redispatchCampaignSchema,
) {}
