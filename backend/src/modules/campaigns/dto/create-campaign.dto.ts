import { createZodDto } from 'nestjs-zod';
import { createCampaignSchema } from '../../../schemas/contracts/campaign.schema';

export class CreateCampaignDto extends createZodDto(createCampaignSchema) {}
