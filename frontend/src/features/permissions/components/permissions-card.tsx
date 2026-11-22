import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PermissionsMatrix } from './permissions-matrix';

/** DB15: a tela Permissões é este card na página Configurações (a rota inteira já é só do ADMIN). */
export function PermissionsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Permissões</CardTitle>
        <p className="text-sm" style={{ color: 'var(--foreground-muted)' }}>
          Defina o que Supervisor e Operador podem fazer. Administrador tem todas as
          permissões e Leitura nenhuma; essas colunas não mudam.
        </p>
      </CardHeader>
      <CardContent data-testid="permissions-card">
        <PermissionsMatrix />
      </CardContent>
    </Card>
  );
}
