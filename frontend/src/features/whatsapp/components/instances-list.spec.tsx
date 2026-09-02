import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InstancesList } from './instances-list';

function wrap(ui: React.ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {ui}
    </QueryClientProvider>,
  );
}

const instances = [
  {
    id: '1', name: 'Atendimento', isDefault: true, isActive: true,
    sentToday: 12, dailySendLimit: 500, phoneE164: '+5511',
    evolutionInstanceName: 'evo1', ownerUserId: null,
    profileName: null, profilePictureUrl: null, createdAt: '',
    lastConnectionState: 'open',
  },
  {
    id: '2', name: 'Vendas', isDefault: false, isActive: true,
    sentToday: 0, dailySendLimit: 500, phoneE164: null,
    evolutionInstanceName: 'evo2', ownerUserId: null,
    profileName: null, profilePictureUrl: null, createdAt: '',
    lastConnectionState: null,
  },
] as any;

// U1: the device WhatsApp profile (name/photo/phone) is persisted by the
// backend and must render on the Conectar card.
const profiled = [
  {
    id: '3', name: 'Suporte Manaus', isDefault: false, isActive: true,
    sentToday: 0, dailySendLimit: 500, phoneE164: '+559231550102',
    evolutionInstanceName: 'evo3', ownerUserId: null,
    profileName: 'ORGAMIND', profilePictureUrl: 'https://pps.whatsapp.net/pic.jpg',
    createdAt: '', lastConnectionState: 'open',
  },
] as any;

describe('InstancesList — device profile (U1)', () => {
  it('mostra profileName · telefone · estado e o avatar com a foto do dispositivo', () => {
    const { container } = wrap(
      <InstancesList
        instances={profiled}
        role="ADMIN"
        isInstanceOnline={() => true}
        onAction={() => {}}
      />,
    );
    expect(
      screen.getByText('ORGAMIND · +559231550102 · conectado'),
    ).toBeInTheDocument();
    const imgSrc = container.querySelector('img')?.getAttribute('src');
    expect(imgSrc).toBe('https://pps.whatsapp.net/pic.jpg');
  });

  it('sem foto: avatar cai para as iniciais do nome da instância', () => {
    const noPic = [{ ...profiled[0], profilePictureUrl: null }] as any;
    const { container } = wrap(
      <InstancesList
        instances={noPic}
        role="ADMIN"
        isInstanceOnline={() => true}
        onAction={() => {}}
      />,
    );
    const img = container.querySelector('img');
    expect(img).toBeNull();
    // initials('Suporte Manaus') -> 'SM'
    expect(screen.getByText('SM')).toBeInTheDocument();
  });

  it('sem profileName e sem telefone mantém o traço no subtítulo', () => {
    // 'Vendas' (instances[1]) has profileName=null and phoneE164=null; offline
    // without a phone renders the "escaneie QR" state label.
    wrap(<InstancesList instances={instances} role="ADMIN" onAction={() => {}} />);
    expect(screen.getByText('— · escaneie QR')).toBeInTheDocument();
  });
});

describe('InstancesList', () => {
  it('expande apenas uma instância por vez', () => {
    wrap(<InstancesList instances={instances} role="ADMIN" onAction={() => {}} />);
    // 'Atendimento' is the first row, expanded by default
    expect(screen.getByText(/12 \/ 500/)).toBeInTheDocument();
    // Click the second row's name to expand it (and collapse the first)
    fireEvent.click(screen.getByText('Vendas'));
    expect(screen.queryByText(/12 \/ 500/)).not.toBeInTheDocument();
    expect(screen.getByText(/0 \/ 500/)).toBeInTheDocument();
  });

  it('ADMIN vê botão "Nova conexão"', () => {
    wrap(<InstancesList instances={instances} role="ADMIN" onAction={() => {}} />);
    expect(screen.getByRole('button', { name: /Nova conexão/i })).toBeInTheDocument();
  });

  it('OPERATOR não vê botão "Nova conexão"', () => {
    wrap(<InstancesList instances={instances} role="OPERATOR" onAction={() => {}} />);
    expect(screen.queryByRole('button', { name: /Nova conexão/i })).not.toBeInTheDocument();
  });

  it('ADMIN vê as ações de conexão Evolution (QR/Reiniciar) no card expandido', () => {
    wrap(<InstancesList instances={instances} role="ADMIN" onAction={() => {}} />);
    // Second row ('Vendas') is offline, so once expanded it exposes the QR
    // connect action alongside Reiniciar/Configurações.
    fireEvent.click(screen.getByText('Vendas'));
    expect(screen.getByRole('button', { name: /Conectar \(QR\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reiniciar/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Configurações/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remover/i })).toBeInTheDocument();
  });
});
