import { createZodDto } from 'nestjs-zod';
import {
  sendCampaignBatchSchema,
  listCampaignRecipientsQuerySchema,
} from '../../../schemas/contracts/campaign.schema';

/** ZE — corpo do "Enviar lote": quantos enviar agora. */
export class SendCampaignBatchDto extends createZodDto(
  sendCampaignBatchSchema,
) {}

/** ZE — query da aba "enviados × não enviados". */
export class ListCampaignRecipientsDto extends createZodDto(
  listCampaignRecipientsQuerySchema,
) {}
