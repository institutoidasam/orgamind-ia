import { Badge } from '@/components/ui/badge';
import { authorizationFlag, type ContactAuthorization } from '../authorization';

const FLAG_LABEL = { unverified: 'Origem não verificada', not_authorized: 'Sem autorização' } as const;

/** Selo da linha: só quem precisa de regularização leva selo. */
export function AuthorizationBadge({ authorization }: { authorization: ContactAuthorization }) {
  const flag = authorizationFlag(authorization);
  if (flag === null) return null;
  return <Badge variant={flag === 'not_authorized' ? 'destructive' : 'secondary'}>{FLAG_LABEL[flag]}</Badge>;
}
