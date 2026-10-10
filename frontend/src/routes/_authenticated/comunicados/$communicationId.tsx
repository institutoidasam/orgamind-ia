import { createFileRoute } from '@tanstack/react-router';
import { NoticeDetailRoutePage } from '@/features/internal-communications/components/notice-pages';

export const Route = createFileRoute('/_authenticated/comunicados/$communicationId')({
  component: NoticeDetailRoutePage,
});
