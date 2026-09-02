import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { Prisma } from '@prisma/client';
import { ConsentAdminService } from './consent-admin.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import { OrganizationService } from '../organization/organization.service';
import {
  ConsentTextVersionTakenError,
  PurposeInUseError,
  PurposeKeyTakenError,
  PurposeNotFoundError,
} from './errors/consent.errors';

const known = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('x', {
    code,
    clientVersion: '5',
  });

const PURPOSE_ROW = {
  key: 'continuum_avisos',
  label: 'Avisos do CONTINUUM',
  description: 'Comunicados operacionais do programa.',
  isSensitive: false,
  active: true,
  createdAt: new Date('2026-07-11'),
  updatedAt: new Date('2026-07-11'),
  texts: [],
};

/** A organização titular DESTE deploy — configuração, não constante de código. */
const ORG = {
  id: 'singleton',
  name: 'CONTINUUM',
  legalName: 'Canal do Matheus Garcia - CONTINUUM',
  privacyPolicyUrl: null,
  supportContact: null,
};

describe('ConsentAdminService — finalidades', () => {
  let prisma: MockProxy<PrismaService>;
  let audit: MockProxy<AuditService>;
  let organization: MockProxy<OrganizationService>;
  let svc: ConsentAdminService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    audit = mockDeep<AuditService>();
    prisma.consentPurpose.create.mockResolvedValue(PURPOSE_ROW as never);
    prisma.consentPurpose.update.mockResolvedValue(PURPOSE_ROW as never);
    prisma.consentPurpose.findUnique.mockResolvedValue(PURPOSE_ROW as never);
    organization = mockDeep<OrganizationService>();
    organization.get.mockResolvedValue(ORG);
    svc = new ConsentAdminService(prisma, audit, organization);
  });

  it('cria uma finalidade e audita quem criou', async () => {
    const view = await svc.createPurpose(
      {
        key: 'continuum_avisos',
        label: 'Avisos do CONTINUUM',
        description: 'Comunicados operacionais do programa.',
        isSensitive: false,
        active: true,
      },
      'user-1',
    );

    expect(prisma.consentPurpose.create).toHaveBeenCalledWith({
      data: {
        key: 'continuum_avisos',
        label: 'Avisos do CONTINUUM',
        description: 'Comunicados operacionais do programa.',
        isSensitive: false,
        active: true,
      },
      include: expect.anything(),
    });
    expect(view.key).toBe('continuum_avisos');
    expect(audit.log).toHaveBeenCalledWith(
      'consent.purpose_created',
      'ConsentPurpose',
      'continuum_avisos',
      expect.objectContaining({ actorUserId: 'user-1' }),
    );
  });

  it('recusa key duplicada com erro PT-BR', async () => {
    prisma.consentPurpose.create.mockRejectedValue(known('P2002'));

    await expect(
      svc.createPurpose(
        {
          key: 'continuum_avisos',
          label: 'x',
          description: 'y',
          isSensitive: false,
          active: true,
        },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(PurposeKeyTakenError);
  });

  it('edita rótulo/descrição/sensibilidade/ativo — e nunca a key', async () => {
    await svc.updatePurpose(
      'continuum_avisos',
      { label: 'Avisos CONTINUUM', isSensitive: true, active: false },
      'user-1',
    );

    const args = prisma.consentPurpose.update.mock.calls[0][0] as {
      where: { key: string };
      data: Record<string, unknown>;
    };
    expect(args.where).toEqual({ key: 'continuum_avisos' });
    expect(args.data).toEqual({
      label: 'Avisos CONTINUUM',
      isSensitive: true,
      active: false,
    });
    // A key é a chave estável usada pelo gate e por toda a trilha de eventos:
    // renomeá-la órfã os ConsentEvent já gravados.
    expect(args.data.key).toBeUndefined();
  });

  it('editar finalidade inexistente → PurposeNotFoundError', async () => {
    prisma.consentPurpose.update.mockRejectedValue(known('P2025'));

    await expect(
      svc.updatePurpose('nao_existe', { label: 'x' }, 'user-1'),
    ).rejects.toBeInstanceOf(PurposeNotFoundError);
  });
});

describe('ConsentAdminService — textos versionados', () => {
  let prisma: MockProxy<PrismaService>;
  let audit: MockProxy<AuditService>;
  let organization: MockProxy<OrganizationService>;
  let svc: ConsentAdminService;

  const input = {
    purposeKey: 'continuum_avisos',
    version: 'optin-continuum-v2',
    body: 'Autorizo o CONTINUUM a me enviar mensagens no WhatsApp sobre avisos.',
  };

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    audit = mockDeep<AuditService>();
    prisma.consentPurpose.findUnique.mockResolvedValue(PURPOSE_ROW as never);
    prisma.consentText.create.mockResolvedValue({
      id: 'ct2',
      version: 'optin-continuum-v2',
      purposeKey: 'continuum_avisos',
      body: input.body,
      activeFrom: new Date('2026-07-11'),
      createdAt: new Date('2026-07-11'),
    } as never);
    organization = mockDeep<OrganizationService>();
    organization.get.mockResolvedValue(ORG);
    svc = new ConsentAdminService(prisma, audit, organization);
  });

  it('publica uma nova versão SEM tocar nas anteriores', async () => {
    const view = await svc.publishText(input, 'user-1');

    expect(view.version).toBe('optin-continuum-v2');
    expect(prisma.consentText.create).toHaveBeenCalledOnce();
    // O texto é a PROVA (art. 8º §2º): os consentimentos já colhidos apontam
    // para a versão que a pessoa viu. Publicar v2 não pode reescrever a v1.
    expect(prisma.consentText.update).not.toHaveBeenCalled();
    expect(prisma.consentText.updateMany).not.toHaveBeenCalled();
    expect(prisma.consentText.delete).not.toHaveBeenCalled();
    expect(prisma.consentText.deleteMany).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      'consent.text_published',
      'ConsentText',
      'ct2',
      expect.objectContaining({ purposeKey: 'continuum_avisos' }),
    );
  });

  it('recusa versão repetida na mesma finalidade', async () => {
    prisma.consentText.create.mockRejectedValue(known('P2002'));

    await expect(svc.publishText(input, 'user-1')).rejects.toBeInstanceOf(
      ConsentTextVersionTakenError,
    );
  });

  it('recusa texto para finalidade inexistente', async () => {
    prisma.consentPurpose.findUnique.mockResolvedValue(null as never);

    await expect(svc.publishText(input, 'user-1')).rejects.toBeInstanceOf(
      PurposeNotFoundError,
    );
    expect(prisma.consentText.create).not.toHaveBeenCalled();
  });
});

describe('ConsentAdminService.deletePurpose', () => {
  let prisma: MockProxy<PrismaService>;
  let audit: MockProxy<AuditService>;
  let organization: MockProxy<OrganizationService>;
  let svc: ConsentAdminService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    audit = mockDeep<AuditService>();
    prisma.consentPurpose.findUnique.mockResolvedValue(PURPOSE_ROW as never);
    prisma.contactConsent.count.mockResolvedValue(0 as never);
    prisma.consentEvent.count.mockResolvedValue(0 as never);
    prisma.campaign.count.mockResolvedValue(0 as never);
    prisma.optInLink.count.mockResolvedValue(0 as never);
    prisma.$transaction.mockResolvedValue([] as never);
    organization = mockDeep<OrganizationService>();
    organization.get.mockResolvedValue(ORG);
    svc = new ConsentAdminService(prisma, audit, organization);
  });

  it('apaga uma finalidade que nunca foi usada (e os textos dela)', async () => {
    await svc.deletePurpose('continuum_avisos', 'user-1');

    expect(prisma.consentText.deleteMany).toHaveBeenCalledWith({
      where: { purposeKey: 'continuum_avisos' },
    });
    expect(prisma.consentPurpose.delete).toHaveBeenCalledWith({
      where: { key: 'continuum_avisos' },
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it('NÃO apaga finalidade com consentimento vinculado', async () => {
    prisma.contactConsent.count.mockResolvedValue(12 as never);

    await expect(
      svc.deletePurpose('continuum_avisos', 'user-1'),
    ).rejects.toBeInstanceOf(PurposeInUseError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.consentPurpose.delete).not.toHaveBeenCalled();
  });

  it('NÃO apaga finalidade que tem trilha de eventos (mesmo sem estado ativo)', async () => {
    // Revogar ≠ apagar: um ConsentEvent REVOKE também é prova, e apagar a
    // finalidade órfã a trilha inteira.
    prisma.consentEvent.count.mockResolvedValue(3 as never);

    await expect(
      svc.deletePurpose('continuum_avisos', 'user-1'),
    ).rejects.toBeInstanceOf(PurposeInUseError);
    expect(prisma.consentPurpose.delete).not.toHaveBeenCalled();
  });

  it('NÃO apaga finalidade usada por campanha', async () => {
    prisma.campaign.count.mockResolvedValue(1 as never);

    await expect(
      svc.deletePurpose('continuum_avisos', 'user-1'),
    ).rejects.toBeInstanceOf(PurposeInUseError);
  });

  it('a mensagem do erro em PT-BR sugere desativar', async () => {
    prisma.contactConsent.count.mockResolvedValue(12 as never);

    await expect(
      svc.deletePurpose('continuum_avisos', 'user-1'),
    ).rejects.toThrow(/desative/i);
  });

  it('apagar finalidade inexistente → PurposeNotFoundError', async () => {
    prisma.consentPurpose.findUnique.mockResolvedValue(null as never);

    await expect(
      svc.deletePurpose('nao_existe', 'user-1'),
    ).rejects.toBeInstanceOf(PurposeNotFoundError);
  });
});

/**
 * O CAMINHO CLARO para trocar a organização nomeada num texto de consentimento.
 *
 * Os `ConsentText` já publicados nomeiam quem os publicou, e não se reescrevem —
 * são a prova do que a pessoa leu. O que o orgamind oferece é o rascunho da versão
 * NOVA, já com a identidade configurada, e o aviso de que a vigente está errada.
 */
describe('ConsentAdminService.suggestText', () => {
  let prisma: MockProxy<PrismaService>;
  let audit: MockProxy<AuditService>;
  let organization: MockProxy<OrganizationService>;
  let svc: ConsentAdminService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    audit = mockDeep<AuditService>();
    organization = mockDeep<OrganizationService>();
    organization.get.mockResolvedValue(ORG);
    svc = new ConsentAdminService(prisma, audit, organization);
  });

  const withTexts = (texts: unknown[]) =>
    prisma.consentPurpose.findUnique.mockResolvedValue({
      ...PURPOSE_ROW,
      label: 'Notícias e avisos',
      texts,
    } as never);

  it('compõe o corpo com a organização CONFIGURADA', async () => {
    withTexts([]);

    const draft = await svc.suggestText('continuum_avisos');

    expect(draft.body).toContain('CONTINUUM');
    expect(draft.body).not.toMatch(/idasam/i);
    expect(draft.body).toContain('notícias e avisos');
    expect(draft.version).toBe('optin-continuum-v1');
  });

  it('sinaliza que o texto VIGENTE nomeia outra organização — os consentimentos colhidos por ele não valem para esta', async () => {
    withTexts([
      {
        id: 't1',
        version: 'optin-v1',
        body: 'Autorizo o IDASAM (Instituto…) a me enviar mensagens no WhatsApp.',
        activeFrom: new Date('2026-01-01'),
        createdAt: new Date('2026-01-01'),
      },
    ]);

    const draft = await svc.suggestText('continuum_avisos');

    expect(draft.activeTextNamesOrganization).toBe(false);
    // E a versão sugerida não colide com a que já existe.
    expect(draft.version).toBe('optin-continuum-v1');
  });

  it('quando o vigente JÁ nomeia a organização, não há o que corrigir', async () => {
    withTexts([
      {
        id: 't2',
        version: 'optin-continuum-v1',
        body: 'Autorizo CONTINUUM a me enviar mensagens no WhatsApp.',
        activeFrom: new Date('2026-07-01'),
        createdAt: new Date('2026-07-01'),
      },
    ]);

    const draft = await svc.suggestText('continuum_avisos');

    expect(draft.activeTextNamesOrganization).toBe(true);
    expect(draft.version).toBe('optin-continuum-v2');
  });

  it('finalidade inexistente → erro (nunca compõe texto para key inventada)', async () => {
    prisma.consentPurpose.findUnique.mockResolvedValue(null);

    await expect(svc.suggestText('nao_existe')).rejects.toBeInstanceOf(
      PurposeNotFoundError,
    );
  });
});
