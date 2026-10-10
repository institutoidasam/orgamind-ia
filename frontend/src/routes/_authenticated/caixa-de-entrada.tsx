import { createFileRoute } from '@tanstack/react-router';
import { InboxPage } from '@/features/internal-communications/components/inbox-page';

export const Route = createFileRoute('/_authenticated/caixa-de-entrada')({ component: InboxPage });
