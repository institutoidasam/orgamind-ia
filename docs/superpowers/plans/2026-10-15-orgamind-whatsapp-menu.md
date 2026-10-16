# Seção WhatsApp no menu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Devolver ao menu, numa seção "WhatsApp", as telas Inbox externo, Contatos, Templates, Segmentos e Campanhas para ADMIN e OPERATOR.

**Architecture:** Só frontend. `NavSection` ganha `'whatsapp'`; as cinco entradas legadas passam para essa seção sem `hideInSidebar`; o `Sidebar` renderiza a seção entre "Acompanhar" e "Administração" apenas quando não vazia. Rotas, paleta e breadcrumb continuam derivando de `NAV`.

**Tech Stack:** React + TanStack Router, Vitest + Testing Library, Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-10-15-orgamind-whatsapp-menu.md`
**Ledger:** `.superpowers/sdd/2026-10-15-orgamind-whatsapp-menu/progress.md`

## Global Constraints

- Ordem da seção: `/inbox`, `/contacts`, `/templates`, `/segments`, `/campaigns` (ordem do menu antigo `f3ffcc5`).
- Rótulos inalterados: "Inbox externo", "Contatos", "Templates", "Segmentos", "Campanhas"; título da seção "WhatsApp".
- Papéis: `LEGACY_ROLES` (ADMIN, OPERATOR) sem mudança; nenhum arquivo de backend muda.
- Fora do sidebar: `/imports`, `/consentimento`, `/opt-in-links`, `/configuracoes`.
- Oito módulos internos e seus três grupos ficam exatamente como estão.
- Sem commit/push/deploy (não autorizados nesta sessão); o diff fica na branch `codex/whatsapp-menu-section`.

## Review Focus

- Barra recolhida: os links da seção WhatsApp mantêm `title` como tooltip (o eyebrow some).
- Rota aninhada: `/campaigns/cmp-1` marca "Campanhas" como `aria-current="page"`.
- Papel ausente (usuário ainda carregando): `navSection('whatsapp', undefined)` é vazio e a seção não renderiza.
- Gaveta mobile: clicar um link da seção WhatsApp chama `onNavigate` (fecha a gaveta).
- Opt-in/Imports/Configurações não vazam para nenhuma das quatro seções e continuam com breadcrumb.

---

### Task 1: Seção WhatsApp no manifesto e no sidebar

**Files:**
- Modify: `frontend/src/lib/nav.ts` (tipo `NavSection` linha 27; entradas legadas linhas 84-98)
- Modify: `frontend/src/components/layout/sidebar.tsx` (linhas 35-49)
- Modify: `frontend/src/release-notes.ts` (topo de `RELEASE_NOTES`, linha 33)
- Test: `frontend/src/lib/nav.spec.ts`, `frontend/src/components/layout/sidebar.spec.tsx`, `frontend/src/release-notes.spec.ts`, `frontend/e2e/import-and-contacts.spec.ts`

**Interfaces:**
- Produces: `NavSection = 'ops' | 'sys' | 'whatsapp' | 'admin'`; `navSection('whatsapp', role)` devolve as cinco entradas na ordem acima para ADMIN/OPERATOR e `[]` para os demais.

- [ ] **Step 1: Testes que falham — `frontend/src/lib/nav.spec.ts`**

Dentro do primeiro `describe` (o que contém "organiza exatamente os oito módulos internos"), acrescentar:

```ts
  it('mostra a seção WhatsApp do menu antigo para ADMIN e OPERATOR, na ordem antiga', () => {
    for (const role of ['ADMIN', 'OPERATOR'] as const) {
      expect(navSection('whatsapp', role).map((item) => item.to)).toEqual([
        '/inbox', '/contacts', '/templates', '/segments', '/campaigns',
      ]);
    }
  });

  it('não mostra a seção WhatsApp para SUPERVISOR, VIEWER ou papel ausente', () => {
    expect(navSection('whatsapp', 'SUPERVISOR')).toEqual([]);
    expect(navSection('whatsapp', 'VIEWER')).toEqual([]);
    expect(navSection('whatsapp', undefined)).toEqual([]);
  });

  it('mantém Imports, opt-in e Configurações fora de todas as seções, com breadcrumb', () => {
    const inSidebar = (['ops', 'sys', 'whatsapp', 'admin'] as const).flatMap((s) =>
      navSection(s, 'ADMIN').map((n) => n.to),
    );
    for (const route of ['/imports', '/consentimento', '/opt-in-links', '/configuracoes']) {
      expect(inSidebar).not.toContain(route);
      expect(navLabelFor(route)).not.toBe('—');
    }
  });
```

No `describe('telas de opt-in: fora do menu, vivas na rota')`, trocar `(['ops', 'sys', 'admin'] as const)` por `(['ops', 'sys', 'whatsapp', 'admin'] as const)`.

- [ ] **Step 2: Testes que falham — `frontend/src/components/layout/sidebar.spec.tsx`**

Acrescentar ao `describe('Sidebar')`:

```tsx
  it('mostra a seção WhatsApp só para ADMIN e OPERATOR, sem Imports', () => {
    currentPath = '/contacts';
    for (const [role, visible] of [['ADMIN', true], ['OPERATOR', true], ['SUPERVISOR', false], ['VIEWER', false]] as const) {
      const { unmount } = render(<Sidebar collapsed={false} user={{ email: `${role}@orgamind.com`, name: role, role }} />);
      if (visible) {
        expect(screen.getByText('WhatsApp')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Contatos' })).toHaveAttribute('aria-current', 'page');
        for (const name of ['Inbox externo', 'Templates', 'Segmentos', 'Campanhas']) {
          expect(screen.getByRole('link', { name })).toBeInTheDocument();
        }
      } else {
        expect(screen.queryByText('WhatsApp')).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Contatos' })).not.toBeInTheDocument();
      }
      expect(screen.queryByRole('link', { name: 'Imports' })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('marca Campanhas em rota aninhada e fecha a gaveta ao navegar pela seção WhatsApp', () => {
    currentPath = '/campaigns/cmp-1';
    const onNavigate = vi.fn();
    render(<Sidebar collapsed={false} user={{ email: 'op@orgamind.com', name: 'Op', role: 'OPERATOR' }} onNavigate={onNavigate} />);

    expect(screen.getByRole('link', { name: 'Campanhas' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('link', { name: 'Contatos' }));
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it('mantém tooltip nos links da seção WhatsApp com a barra recolhida', () => {
    currentPath = '/dashboard';
    render(<Sidebar collapsed user={{ email: 'ana@orgamind.com', name: 'Ana', role: 'ADMIN' }} />);

    expect(screen.queryByText('WhatsApp')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contatos' })).toHaveAttribute('title', 'Contatos');
  });
```

- [ ] **Step 3: Teste que falha — `frontend/src/release-notes.spec.ts`**

Substituir o caso `'registra os módulos internos como a novidade mais recente'` por:

```ts
  it('registra a seção WhatsApp como a novidade mais recente', () => {
    expect(RELEASE_NOTES[0]).toMatchObject({
      version: '2026.10.15',
      date: '2026-10-15',
    });
    expect(RELEASE_NOTES[0].title).toMatch(/whatsapp/i);
    expect(RELEASE_NOTES[1].version).toBe('2026.10.10');
  });
```

- [ ] **Step 4: Rodar e ver falhar**

Run: `gate --test frontend/src/lib/nav.spec.ts`, `gate --test frontend/src/components/layout/sidebar.spec.tsx`, `gate --test frontend/src/release-notes.spec.ts`
Expected: FAIL — `navSection('whatsapp', …)` vazio, texto "WhatsApp" ausente, `RELEASE_NOTES[0].version` = `'2026.10.10'`. (Também pode falhar no `tsc` por `'whatsapp'` não pertencer a `NavSection` — é a falha esperada.)

- [ ] **Step 5: Implementar — `frontend/src/lib/nav.ts`**

Linha 27:

```ts
export type NavSection = 'ops' | 'sys' | 'whatsapp' | 'admin';
```

Substituir o comentário e as entradas legadas (linhas 84-98) por:

```ts
  // Seção WhatsApp — o fluxo de contato externo da versão antiga (spec
  // 2026-10-15-orgamind-whatsapp-menu): cadastrar a pessoa com telefone,
  // enviar por campanha e seguir a conversa no Inbox. O backend legado só
  // aceita ADMIN/OPERATOR; SUPERVISOR/VIEWER não veem a seção nem a paleta
  // para não receberem atalhos que terminariam em 403.
  { to: '/inbox', label: 'Inbox externo', icon: MessageSquare, section: 'whatsapp', roles: LEGACY_ROLES },
  { to: '/contacts', label: 'Contatos', icon: Users, section: 'whatsapp', roles: LEGACY_ROLES },
  { to: '/templates', label: 'Templates', icon: FileText, section: 'whatsapp', roles: LEGACY_ROLES },
  { to: '/segments', label: 'Segmentos', icon: Filter, section: 'whatsapp', roles: LEGACY_ROLES },
  { to: '/campaigns', label: 'Campanhas', icon: Send, section: 'whatsapp', roles: LEGACY_ROLES },
  // Contatos já tem os botões de importar (`contacts.tsx`), então Imports
  // fica fora do menu — alcançável por ali, pela URL e pela paleta.
  {
    to: '/imports',
    label: 'Imports',
    icon: FileSpreadsheet,
    section: 'whatsapp',
    roles: LEGACY_ROLES,
    hideInSidebar: true,
  },
```

- [ ] **Step 6: Implementar — `frontend/src/components/layout/sidebar.tsx`**

Após `const followUp = navSection('sys', role);`:

```tsx
  const whatsapp = navSection('whatsapp', role);
```

Entre a `<Section eyebrow="Acompanhar" … />` e a de "Administração":

```tsx
      {whatsapp.length > 0 && <Section eyebrow="WhatsApp" items={whatsapp} collapsed={collapsed} isActive={isActive} onNavigate={onNavigate} />}
```

- [ ] **Step 7: Implementar — `frontend/src/release-notes.ts`**

Primeiro elemento de `RELEASE_NOTES`:

```ts
  {
    version: '2026.10.15',
    date: '2026-10-15',
    title: 'WhatsApp de volta ao menu',
    items: [
      {
        text: 'Contatos, Inbox externo, Templates, Segmentos e Campanhas voltaram ao menu, na seção WhatsApp: cadastre a pessoa com o telefone e envie a mensagem como na versão anterior.',
        where: '/contacts',
      },
    ],
  },
```

- [ ] **Step 8: Rodar e ver passar**

Run: os três `gate --test` do Step 4 e também `gate --test frontend/src/components/layout/topbar.spec.tsx` e `gate --test frontend/src/components/command-palette.spec.tsx` (consumidores de `NAV`).
Expected: PASS, sem alteração nesses dois últimos.

- [ ] **Step 9: e2e — `frontend/e2e/import-and-contacts.spec.ts`**

Trocar o bloco final (comentário "A rota legada de contatos continua acessível diretamente…" + `await page.goto('/contacts');`) por:

```ts
  // Contatos voltou ao menu, na seção WhatsApp (spec
  // 2026-10-15-orgamind-whatsapp-menu): o teste chega lá pelo sidebar.
  await page
    .getByLabel('Navegação principal')
    .getByRole('link', { name: 'Contatos', exact: true })
    .click();
  await expect(page).toHaveURL(/\/contacts$/);
```

A asserção seguinte (`+5592987654321` visível) fica como está. O comentário sobre `/imports` ser `hideInSidebar` continua verdadeiro.

Execução: o Playwright usa as portas 3000/5173 com `reuseExistingServer`, hoje ocupadas pelo stack `apolloII-dev` de outra sessão — rodar localmente testaria o app errado. Não parar containers alheios: registrar no ledger como lacuna para o workflow `e2e.yml` do CI e validar só `tsc`/lint do arquivo.

- [ ] **Step 10: Fechamento da task**

Run: `gate --changed` (frontend).
Expected: verde, sem regressão nova. Registrar no ledger: arquivos, resultados, lacuna do e2e. Sem commit.

### Task 2: Novidades — "Ver" só para rota acessível ao papel

Adicionada em 2026-10-15 após a verificação pré-deploy (spec §"Novidades: link Ver só para quem acessa a rota"). Depende da Task 1 (concluída; mesmos arquivos `nav.ts`/`nav.spec.ts`, agora sem dono concorrente).

**Files:**
- Modify: `frontend/src/lib/nav.ts` (bloco de `navLabelFor`, fim do arquivo)
- Modify: `frontend/src/components/layout/release-notes-dialog.tsx` (render do `item.where`, ~linhas 55-66)
- Test: `frontend/src/lib/nav.spec.ts`, `frontend/src/components/layout/release-notes-dialog.spec.tsx`

**Interfaces:**
- Consumes: `NAV`, `isNavActive`, `NavRole` (Task 1, `nav.ts`); `useAuthStore` (`frontend/src/stores/auth.store.ts`, `user: AuthUser | null`, `AuthUser.role: 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'VIEWER'`).
- Produces: `canAccessPath(path: string, role?: NavRole): boolean` em `nav.ts`.

- [ ] **Step 1: Teste que falha — `frontend/src/lib/nav.spec.ts`**

```ts
describe('canAccessPath', () => {
  it('libera a rota pelo papel do NAV, inclusive em rota aninhada', () => {
    expect(canAccessPath('/contacts', 'OPERATOR')).toBe(true);
    expect(canAccessPath('/campaigns/new', 'ADMIN')).toBe(true);
    expect(canAccessPath('/dashboard', 'VIEWER')).toBe(true);
  });

  it('nega rota legada a SUPERVISOR/VIEWER, administração a OPERATOR, e papel ausente ou rota fora do NAV', () => {
    expect(canAccessPath('/contacts', 'VIEWER')).toBe(false);
    expect(canAccessPath('/campaigns', 'SUPERVISOR')).toBe(false);
    expect(canAccessPath('/setores', 'OPERATOR')).toBe(false);
    expect(canAccessPath('/contacts', undefined)).toBe(false);
    expect(canAccessPath('/rota-inexistente', 'ADMIN')).toBe(false);
  });
});
```

(Acrescentar `canAccessPath` ao import de `./nav`.)

- [ ] **Step 2: Teste que falha — `frontend/src/components/layout/release-notes-dialog.spec.tsx`**

No mock de `@/release-notes`, acrescentar um item `{ text: 'Item da visão geral.', where: '/dashboard' }` ao fim de `items`. Importar `useAuthStore` de `@/stores/auth.store` e, num `beforeEach`, definir ADMIN para os testes existentes continuarem válidos:

```tsx
function signInAs(role: 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'VIEWER') {
  useAuthStore.setState({ user: { id: 'u1', email: 'u@orgamind.com', name: 'U', role } });
}
beforeEach(() => signInAs('ADMIN'));
afterEach(() => useAuthStore.setState({ user: null }));
```

Novo caso:

```tsx
  it('esconde "Ver" de rota que o papel não acessa, mantendo o texto', () => {
    signInAs('VIEWER');
    render(<ReleaseNotesDialog open onOpenChange={() => {}} />);

    expect(screen.getByText(/Item com link\./)).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Ver' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/dashboard');
  });
```

Ajustar o caso existente `'mostra "Ver" só no item que tem \`where\`'` se ele contar links: com ADMIN agora há dois ("/contacts" e "/dashboard"). Conferir também se `useAuthStore.setState` com `persist` não vaza entre arquivos (o `afterEach` zera).

- [ ] **Step 3: Rodar e ver falhar**

Run (cwd `frontend`): `gate --test src/lib/nav.spec.ts` e `gate --test src/components/layout/release-notes-dialog.spec.tsx`
Expected: FAIL — `canAccessPath` não exportado; VIEWER ainda vê dois "Ver".

- [ ] **Step 4: Implementar — `frontend/src/lib/nav.ts`**

Extrair o casamento de `navLabelFor` e reutilizá-lo:

```ts
/** Entrada do NAV dona de `path` — prefixo mais longo primeiro (`/campaigns` vence `/`). */
function navItemFor(path: string): NavItem | undefined {
  return [...NAV]
    .sort((a, b) => b.to.length - a.to.length)
    .find((n) => isNavActive(path, n.to));
}

/**
 * O papel pode abrir `path`? Decide pelo `roles` da entrada do NAV dona da
 * rota. Rota fora do manifesto ou papel ausente: não — quem chama esconde o
 * atalho em vez de levar a uma tela cujo backend responde 403.
 */
export function canAccessPath(path: string, role?: NavRole): boolean {
  if (!role) return false;
  return Boolean(navItemFor(path)?.roles?.includes(role));
}

export function navLabelFor(path: string): string {
  if (path.startsWith('/campaigns/')) return 'Campanha';
  return navItemFor(path)?.label ?? '—';
}
```

(manter o JSDoc existente de `navLabelFor` acima dele.)

- [ ] **Step 5: Implementar — `frontend/src/components/layout/release-notes-dialog.tsx`**

```tsx
import { useAuthStore } from '@/stores/auth.store';
import { canAccessPath, type NavRole } from '@/lib/nav';
```

Dentro do componente:

```tsx
  const role = useAuthStore((s) => s.user?.role) as NavRole | undefined;
```

e trocar `{item.where && (` por `{item.where && canAccessPath(item.where, role) && (`.

- [ ] **Step 6: Rodar e ver passar**

Run (cwd `frontend`): os dois `gate --test` do Step 3, mais `gate --test src/components/layout/topbar.spec.tsx` (consome `navLabelFor`) e `gate --test src/components/layout/release-notes-button.spec.tsx` (monta o diálogo).
Expected: PASS.

- [ ] **Step 7: Fechamento**

Run (cwd `frontend`): `gate --changed --base origin/main`.
Expected: PASS. Sem commit (controlador integra).
