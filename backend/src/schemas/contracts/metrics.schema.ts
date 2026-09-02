import { z } from 'zod';

const metricBlockSchema = z.object({
  count: z.number(),
  meta: z.string(),
  sparkline: z.array(z.number()).length(7),
});

const liveFlowSchema = z.object({
  queued: z.number(),
  sent: z.number(),
  delivered: z.number(),
  read: z.number(),
  failed: z.number(),
});

export const dashboardMetricsSchema = z.object({
  activeCampaigns: metricBlockSchema,
  activeContacts: metricBlockSchema,
  approvedTemplates: metricBlockSchema,
  deliveryRate7d: metricBlockSchema, // count holds 0-100
  liveFlow: liveFlowSchema,
});

export type DashboardMetrics = z.infer<typeof dashboardMetricsSchema>;
