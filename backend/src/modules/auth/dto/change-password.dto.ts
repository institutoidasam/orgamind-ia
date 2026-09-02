import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const changePasswordInputSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

export class ChangePasswordDto extends createZodDto(changePasswordInputSchema) {}
