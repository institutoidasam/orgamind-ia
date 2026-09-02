import { createZodDto } from 'nestjs-zod';
import { listCampaignMessagesQuerySchema } from '../../../schemas/contracts/campaign.schema';

export class ListCampaignMessagesDto extends createZodDto(
  listCampaignMessagesQuerySchema,
) {}
