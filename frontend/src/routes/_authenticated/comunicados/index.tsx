import { createFileRoute } from '@tanstack/react-router';
import { NoticesPage } from '@/features/internal-communications/components/notice-pages';

export const Route = createFileRoute('/_authenticated/comunicados/')({ component: NoticesPage });
