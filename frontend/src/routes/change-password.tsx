import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { useAuthStore } from '@/stores/auth.store';
import { ChangePasswordPage } from '@/components/auth/change-password-page';

const searchSchema = z.object({
  redirect: z.string().optional(),
});

export const Route = createFileRoute('/change-password')({
  validateSearch: searchSchema,
  beforeLoad: () => {
    if (!useAuthStore.getState().accessToken) {
      throw redirect({ to: '/login' });
    }
  },
  component: ChangePasswordPage,
});
