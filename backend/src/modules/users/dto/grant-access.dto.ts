import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Dar acesso (C2): e-mail normalizado como no convite (trim + lowercase antes
// do z.email(), coluna `email` @unique sensível a caixa) e papel obrigatório.
export const grantAccessSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: z.enum(['ADMIN', 'OPERATOR', 'SUPERVISOR', 'VIEWER']),
});

export class GrantAccessDto extends createZodDto(grantAccessSchema) {}
