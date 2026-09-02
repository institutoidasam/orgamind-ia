// instance-config-drawer.spec.tsx
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Instance } from '../schemas';
import {
  InstanceConfigDrawer,
  instanceConfigFormSchema,
  DEFAULTS,
  RECOMMENDED,
} from './instance-config-drawer';

// jsdom lacks ResizeObserver / pointer-capture used by the Radix primitives.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never);
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// ---- mocks -----------------------------------------------------------------

let mutateAsync = vi.fn().mockResolvedValue({});
let isPending = false;
let isError = false;

vi.mock('../api', () => ({
  useUpdateInstance: () => ({ mutateAsync, isPending, isError }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

// ---- fixtures --------------------------------------------------------------

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    name: 'Conta A',
    evolutionInstanceName: 'evo-1',
    phoneE164: null,
    profileName: null,
    profilePictureUrl: null,
    ownerUserId: null,
    isDefault: false,
    isActive: true,
    dailySendLimit: 500,
    sentToday: 10,
    createdAt: '2026-01-01T00:00:00.000Z',
    rejectCall: true,
    msgCall: '',
    groupsIgnore: true,
    alwaysOnline: false,
    readMessages: false,
    readStatus: false,
    syncFullHistory: false,
    globalPresenceDelayMs: 3000,
    globalJitterMaxMs: 5000,
    sendWindowStartHour: 8,
    sendWindowEndHour: 20,
    sendWindowEnabled: true,
    lastConnectionState: 'open',
    ...overrides,
  };
}

// The Radix Checkbox renders with no accessible name (the visible label text is
// a sibling span inside the wrapping <label>, not associated via for/id). To
// target a specific toggle we locate its label text and read the checkbox
// within the same <label>. This characterizes the real DOM, not an idealized one.
function toggleByLabel(text: string): HTMLElement {
  const labelText = screen.getByText(text);
  const labelEl = labelText.closest('label');
  if (!labelEl) throw new Error(`No wrapping <label> for "${text}"`);
  return within(labelEl).getByRole('checkbox');
}

function wrap(ui: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mutateAsync = vi.fn().mockResolvedValue({});
  isPending = false;
  isError = false;
  toastSuccess.mockClear();
  toastError.mockClear();
});

afterEach(() => cleanup());

// ---- #3: conditional send-window refine ------------------------------------

describe('instanceConfigFormSchema send-window refine', () => {
  const base = {
    rejectCall: true,
    msgCall: '',
    groupsIgnore: true,
    alwaysOnline: false,
    readMessages: false,
    readStatus: false,
    syncFullHistory: false,
    globalPresenceDelayMs: 3000,
    globalJitterMaxMs: 5000,
    dailySendLimit: 500,
  };

  it('passes when the window is disabled even with start >= end', () => {
    const r = instanceConfigFormSchema.safeParse({
      ...base,
      sendWindowEnabled: false,
      sendWindowStartHour: 20,
      sendWindowEndHour: 8,
    });
    expect(r.success).toBe(true);
  });

  it('fails when the window is enabled and start >= end', () => {
    const r = instanceConfigFormSchema.safeParse({
      ...base,
      sendWindowEnabled: true,
      sendWindowStartHour: 20,
      sendWindowEndHour: 8,
    });
    expect(r.success).toBe(false);
  });

  it('passes when the window is enabled and start < end', () => {
    const r = instanceConfigFormSchema.safeParse({
      ...base,
      sendWindowEnabled: true,
      sendWindowStartHour: 8,
      sendWindowEndHour: 20,
    });
    expect(r.success).toBe(true);
  });
});

// ---- #5: RECOMMENDED derivation / divergence -------------------------------

describe('RECOMMENDED vs DEFAULTS', () => {
  it('keeps DEFAULTS and RECOMMENDED as parseable config objects', () => {
    expect(instanceConfigFormSchema.safeParse(DEFAULTS).success).toBe(true);
    expect(instanceConfigFormSchema.safeParse(RECOMMENDED).success).toBe(true);
  });

  it('shares the same key set so neither drifts silently', () => {
    expect(Object.keys(RECOMMENDED).sort()).toEqual(Object.keys(DEFAULTS).sort());
  });
});

// ---- #2: unsaved edits survive an instance poll refresh --------------------

describe('InstanceConfigDrawer — instance poll refresh', () => {
  it('does not wipe unsaved edits when only volatile fields change', async () => {
    const inst = makeInstance({ sentToday: 10 });
    const { rerender } = wrap(
      <InstanceConfigDrawer instance={inst} open onOpenChange={() => {}} />,
    );

    const limitInput = screen.getByLabelText('Limite diário de envios') as HTMLInputElement;
    await userEvent.clear(limitInput);
    await userEvent.type(limitInput, '999');
    expect((screen.getByLabelText('Limite diário de envios') as HTMLInputElement).value).toBe(
      '999',
    );

    // Instances poll refreshes: sentToday + connection state change, same id.
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <InstanceConfigDrawer
          instance={makeInstance({ sentToday: 42, lastConnectionState: 'connecting' })}
          open
          onOpenChange={() => {}}
        />
      </QueryClientProvider>,
    );

    // The unsaved edit must survive.
    expect((screen.getByLabelText('Limite diário de envios') as HTMLInputElement).value).toBe(
      '999',
    );
  });

  it('resets the form to instance values when (re)opened', async () => {
    const inst = makeInstance({ dailySendLimit: 500 });
    const { rerender } = wrap(
      <InstanceConfigDrawer instance={inst} open={false} onOpenChange={() => {}} />,
    );

    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <InstanceConfigDrawer
          instance={makeInstance({ dailySendLimit: 750 })}
          open
          onOpenChange={() => {}}
        />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect((screen.getByLabelText('Limite diário de envios') as HTMLInputElement).value).toBe(
        '750',
      ),
    );
  });
});

// ---- #4: single error surface ----------------------------------------------

describe('InstanceConfigDrawer — single error surface', () => {
  it('does not render the inline Alert when the save mutation errors', () => {
    isError = true;
    wrap(<InstanceConfigDrawer instance={makeInstance()} open onOpenChange={() => {}} />);
    expect(
      screen.queryByText(/Erro ao salvar as configurações\. Verifique a conexão/i),
    ).not.toBeInTheDocument();
  });

  it('surfaces a save failure through a single toast', async () => {
    mutateAsync = vi.fn().mockRejectedValue(new Error('boom'));
    wrap(<InstanceConfigDrawer instance={makeInstance()} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
  });
});

// ---- header / chrome -------------------------------------------------------

describe('InstanceConfigDrawer — chrome', () => {
  it('renders the title with the instance name and the description', () => {
    wrap(
      <InstanceConfigDrawer
        instance={makeInstance({ name: 'Conta A' })}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText(/Configurações — Conta A/)).toBeInTheDocument();
    expect(
      screen.getByText(/Configurações anti-ban para esta instância/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Aparelho — comportamento na UI/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Pacing & limites — anti-ban/i)).toBeInTheDocument();
  });

  it('closes via the Cancelar button', () => {
    const onOpenChange = vi.fn();
    wrap(
      <InstanceConfigDrawer instance={makeInstance()} open onOpenChange={onOpenChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Cancelar$/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('disables Salvar and shows the pending label while saving', () => {
    isPending = true;
    wrap(<InstanceConfigDrawer instance={makeInstance()} open onOpenChange={() => {}} />);
    const btn = screen.getByRole('button', { name: /Salvando…/i });
    expect(btn).toBeDisabled();
  });
});

// ---- toggle fields: render + edit ------------------------------------------

describe('InstanceConfigDrawer — toggle fields render + edit', () => {
  const toggles: { label: string; field: keyof Instance; initial: boolean }[] = [
    { label: 'Rejeitar chamadas', field: 'rejectCall', initial: true },
    { label: 'Ignorar grupos', field: 'groupsIgnore', initial: true },
    { label: 'Sempre online', field: 'alwaysOnline', initial: false },
    { label: 'Marcar mensagens como lidas', field: 'readMessages', initial: false },
    { label: 'Marcar stories como vistos', field: 'readStatus', initial: false },
    { label: 'Sincronizar histórico completo', field: 'syncFullHistory', initial: false },
  ];

  for (const { label, field, initial } of toggles) {
    it(`renders and toggles "${label}"`, async () => {
      wrap(
        <InstanceConfigDrawer
          instance={makeInstance({ [field]: initial } as Partial<Instance>)}
          open
          onOpenChange={() => {}}
        />,
      );
      const cb = toggleByLabel(label);
      expect(cb).toHaveAttribute('data-state', initial ? 'checked' : 'unchecked');
      await userEvent.click(cb);
      await waitFor(() =>
        expect(cb).toHaveAttribute('data-state', initial ? 'unchecked' : 'checked'),
      );
    });
  }

  it('sends the toggled value through the save mutation', async () => {
    wrap(
      <InstanceConfigDrawer
        instance={makeInstance({ alwaysOnline: false })}
        open
        onOpenChange={() => {}}
      />,
    );
    await userEvent.click(toggleByLabel('Sempre online'));
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ alwaysOnline: true });
  });
});

// ---- msgCall text field ----------------------------------------------------

describe('InstanceConfigDrawer — msgCall', () => {
  it('is disabled while rejectCall is off and enabled while on', async () => {
    wrap(
      <InstanceConfigDrawer
        instance={makeInstance({ rejectCall: true })}
        open
        onOpenChange={() => {}}
      />,
    );
    const input = screen.getByLabelText('Mensagem na chamada rejeitada');
    expect(input).not.toBeDisabled();
    await userEvent.click(toggleByLabel('Rejeitar chamadas'));
    await waitFor(() => expect(input).toBeDisabled());
  });

  it('edits and submits the msgCall text', async () => {
    wrap(
      <InstanceConfigDrawer
        instance={makeInstance({ rejectCall: true, msgCall: '' })}
        open
        onOpenChange={() => {}}
      />,
    );
    const input = screen.getByLabelText('Mensagem na chamada rejeitada');
    await userEvent.type(input, 'Olá');
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ msgCall: 'Olá' });
  });
});

// ---- numeric fields: render + edit -----------------------------------------

describe('InstanceConfigDrawer — numeric fields render + edit', () => {
  const numerics: { label: string; field: keyof Instance; initial: number }[] = [
    { label: 'Delay mínimo entre mensagens (ms)', field: 'globalPresenceDelayMs', initial: 3000 },
    { label: 'Jitter aleatório máximo (ms)', field: 'globalJitterMaxMs', initial: 5000 },
    { label: 'Limite diário de envios', field: 'dailySendLimit', initial: 500 },
  ];

  for (const { label, field, initial } of numerics) {
    it(`renders "${label}" with the instance value`, () => {
      wrap(
        <InstanceConfigDrawer
          instance={makeInstance({ [field]: initial } as Partial<Instance>)}
          open
          onOpenChange={() => {}}
        />,
      );
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(String(initial));
    });
  }

  it('edits a numeric field and submits the new value as a number', async () => {
    wrap(
      <InstanceConfigDrawer
        instance={makeInstance({ globalPresenceDelayMs: 3000 })}
        open
        onOpenChange={() => {}}
      />,
    );
    const input = screen.getByLabelText('Delay mínimo entre mensagens (ms)');
    await userEvent.clear(input);
    await userEvent.type(input, '4500');
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ globalPresenceDelayMs: 4500 });
  });

  it('shows a validation error and blocks save when a numeric is out of range', async () => {
    wrap(
      <InstanceConfigDrawer
        instance={makeInstance({ dailySendLimit: 500 })}
        open
        onOpenChange={() => {}}
      />,
    );
    const input = screen.getByLabelText('Limite diário de envios');
    await userEvent.clear(input);
    await userEvent.type(input, '99999');
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/i }));
    await waitFor(() => expect(screen.getByText('Máximo 5.000')).toBeInTheDocument());
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('renders the dailySendLimit hint with sentToday / limit', () => {
    wrap(
      <InstanceConfigDrawer
        instance={makeInstance({ sentToday: 10, dailySendLimit: 500 })}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText(/Enviadas hoje: 10 \/ 500/)).toBeInTheDocument();
  });
});

// ---- RECOMMENDED badge -----------------------------------------------------

describe('InstanceConfigDrawer — RECOMMENDED badge', () => {
  it('hides the badge when the field matches RECOMMENDED', () => {
    wrap(
      <InstanceConfigDrawer
        instance={makeInstance({ alwaysOnline: RECOMMENDED.alwaysOnline })}
        open
        onOpenChange={() => {}}
      />,
    );
    // alwaysOnline recommended is false; nothing diverges initially → no badges.
    expect(screen.queryByText(/Recomendado:/)).not.toBeInTheDocument();
  });

  it('shows a Recomendado badge once a field diverges from RECOMMENDED', async () => {
    wrap(
      <InstanceConfigDrawer
        instance={makeInstance({ alwaysOnline: RECOMMENDED.alwaysOnline })}
        open
        onOpenChange={() => {}}
      />,
    );
    await userEvent.click(toggleByLabel('Sempre online'));
    // recommended value is false → label "Não".
    await waitFor(() =>
      expect(screen.getByText(/Recomendado:\s*Não/)).toBeInTheDocument(),
    );
  });

  it('shows a numeric Recomendado badge when a numeric diverges', async () => {
    wrap(
      <InstanceConfigDrawer
        instance={makeInstance({ globalPresenceDelayMs: RECOMMENDED.globalPresenceDelayMs })}
        open
        onOpenChange={() => {}}
      />,
    );
    const input = screen.getByLabelText('Delay mínimo entre mensagens (ms)');
    await userEvent.clear(input);
    await userEvent.type(input, '1234');
    await waitFor(() =>
      expect(
        screen.getByText(
          new RegExp(`Recomendado:\\s*${RECOMMENDED.globalPresenceDelayMs}`),
        ),
      ).toBeInTheDocument(),
    );
  });
});

// ---- send window -----------------------------------------------------------

describe('InstanceConfigDrawer — send window', () => {
  it('renders the start/end hours from the instance', () => {
    wrap(
      <InstanceConfigDrawer
        instance={makeInstance({ sendWindowStartHour: 8, sendWindowEndHour: 20 })}
        open
        onOpenChange={() => {}}
      />,
    );
    const spins = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    // The window hours are the only min=0/max=23 spinbuttons.
    const hourInputs = spins.filter((s) => s.max === '23');
    expect(hourInputs.map((s) => s.value)).toEqual(['8', '20']);
  });

  it('disables both hour inputs when the window is disabled', async () => {
    wrap(
      <InstanceConfigDrawer
        instance={makeInstance({ sendWindowEnabled: true })}
        open
        onOpenChange={() => {}}
      />,
    );
    const cb = screen.getByRole('checkbox', { name: /Apenas entre/i });
    await userEvent.click(cb);
    const hourInputs = (screen.getAllByRole('spinbutton') as HTMLInputElement[]).filter(
      (s) => s.max === '23',
    );
    await waitFor(() => hourInputs.forEach((s) => expect(s).toBeDisabled()));
  });

  it('blocks save with a validation error when enabled and start >= end', async () => {
    wrap(
      <InstanceConfigDrawer
        instance={makeInstance({
          sendWindowEnabled: true,
          sendWindowStartHour: 20,
          sendWindowEndHour: 8,
        })}
        open
        onOpenChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/i }));
    await waitFor(() =>
      expect(
        screen.getByText('Hora de início deve ser menor que hora de fim'),
      ).toBeInTheDocument(),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('allows save when the window is disabled even with start >= end', async () => {
    wrap(
      <InstanceConfigDrawer
        instance={makeInstance({
          sendWindowEnabled: false,
          sendWindowStartHour: 20,
          sendWindowEndHour: 8,
        })}
        open
        onOpenChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByText('Hora de início deve ser menor que hora de fim'),
    ).not.toBeInTheDocument();
  });

  it('edits an hour and submits the new value', async () => {
    wrap(
      <InstanceConfigDrawer
        instance={makeInstance({
          sendWindowEnabled: true,
          sendWindowStartHour: 8,
          sendWindowEndHour: 20,
        })}
        open
        onOpenChange={() => {}}
      />,
    );
    const startInput = (screen.getAllByRole('spinbutton') as HTMLInputElement[]).filter(
      (s) => s.max === '23',
    )[0];
    await userEvent.clear(startInput);
    await userEvent.type(startInput, '9');
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ sendWindowStartHour: 9 });
  });

  it('shows a Recomendado badge when the window diverges from RECOMMENDED', async () => {
    wrap(
      <InstanceConfigDrawer
        instance={makeInstance({
          sendWindowEnabled: RECOMMENDED.sendWindowEnabled,
          sendWindowStartHour: RECOMMENDED.sendWindowStartHour,
          sendWindowEndHour: RECOMMENDED.sendWindowEndHour,
        })}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.queryByText(/Recomendado:/)).not.toBeInTheDocument();
    const startInput = (screen.getAllByRole('spinbutton') as HTMLInputElement[]).filter(
      (s) => s.max === '23',
    )[0];
    await userEvent.clear(startInput);
    await userEvent.type(startInput, '5');
    await waitFor(() =>
      expect(
        screen.getByText(
          new RegExp(
            `Recomendado:\\s*${RECOMMENDED.sendWindowStartHour}–${RECOMMENDED.sendWindowEndHour}`,
          ),
        ),
      ).toBeInTheDocument(),
    );
  });
});

// ---- save success path -----------------------------------------------------

describe('InstanceConfigDrawer — save success', () => {
  it('saves, raises a success toast, and closes the drawer', async () => {
    const onOpenChange = vi.fn();
    wrap(
      <InstanceConfigDrawer instance={makeInstance()} open onOpenChange={onOpenChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
