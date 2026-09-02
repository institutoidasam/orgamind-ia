import { createZodDto } from 'nestjs-zod';
import { previewCampaignSchema } from '../../../schemas/contracts/campaign.schema';

export class PreviewCampaignDto extends createZodDto(previewCampaignSchema) {}
