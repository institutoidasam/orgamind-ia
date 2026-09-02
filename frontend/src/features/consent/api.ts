import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/lib/api-client';

/**
 * Uma finalidade de consentimento (LGPD art. 8º §4º — autorização genérica é
 * nula, então o consentimento é escopado por finalidade e a campanha declara a
 * sua). Espelha `ConsentPurpose` no backend; só as ATIVAS são servidas.
 */
export const consentPurposeSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  /** art. 11 — finalidade sensível exige consentimento específico e destacado. */
  isSensitive: z.boolean(),
});
export type ConsentPurpose = z.infer<typeof consentPurposeSchema>;

const consentPurposeListSchema = z.array(consentPurposeSchema);

/**
 * As finalidades que o operador pode declarar numa campanha (GET
 * /consent/purposes). Mudam com a frequência com que a organização cria uma
 * finalidade nova — ou seja, quase nunca —, então cacheiam por bastante tempo.
 */
export function useConsentPurposes() {
  return useQuery({
    queryKey: ['consent', 'purposes'] as const,
    queryFn: async () => {
      const json = await api.get('consent/purposes').json();
      return consentPurposeListSchema.parse(json);
    },
    staleTime: 10 * 60_000,
  });
}
