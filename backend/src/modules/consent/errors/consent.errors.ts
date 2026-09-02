import { DomainError } from '../../../shared/errors/domain.error';

export class PurposeNotFoundError extends DomainError {
  constructor(key: string) {
    super({
      code: 'consent.purpose_not_found',
      message: `Finalidade '${key}' não encontrada.`,
      status: 404,
    });
  }
}

export class PurposeKeyTakenError extends DomainError {
  constructor(key: string) {
    super({
      code: 'consent.purpose_key_taken',
      message: `Já existe uma finalidade com a chave '${key}'.`,
      status: 409,
    });
  }
}

/**
 * Revogar ≠ apagar, e isso vale para a finalidade tanto quanto para o
 * consentimento: uma finalidade que já produziu consentimento é parte da trilha
 * de prova (art. 8º §2º) — os `ConsentEvent` apontam para a key dela, e apagá-la
 * transformaria evidência em lixo órfão. Desativar tira-a das campanhas NOVAS
 * sem tocar em nada do que já foi colhido.
 */
export class PurposeInUseError extends DomainError {
  constructor(
    key: string,
    counts: {
      consents: number;
      events: number;
      campaigns: number;
      links: number;
    },
  ) {
    const partes: string[] = [];
    if (counts.consents > 0)
      partes.push(`${counts.consents} consentimento(s) registrado(s)`);
    if (counts.events > 0) partes.push(`${counts.events} evento(s) na trilha`);
    if (counts.campaigns > 0) partes.push(`${counts.campaigns} campanha(s)`);
    if (counts.links > 0) partes.push(`${counts.links} ponto(s) de coleta`);

    super({
      code: 'consent.purpose_in_use',
      message:
        `A finalidade '${key}' não pode ser apagada: existe(m) ${partes.join(', ')} vinculado(s) a ela. ` +
        'Desative-a — ela sai das campanhas novas e a trilha de consentimento, que é prova, permanece intacta.',
      status: 409,
    });
  }
}

export class ConsentTextVersionTakenError extends DomainError {
  constructor(version: string, purposeKey: string) {
    super({
      code: 'consent.text_version_taken',
      message: `Já existe o texto '${version}' para a finalidade '${purposeKey}'. Publique uma versão nova (ex.: ${version}-b) — versões publicadas não são reescritas, porque é o texto que a pessoa viu que prova o consentimento.`,
      status: 409,
    });
  }
}

/** Registrar consentimento em massa para uma finalidade desativada é criar prova morta. */
export class PurposeInactiveError extends DomainError {
  constructor(key: string) {
    super({
      code: 'consent.purpose_inactive',
      message: `A finalidade '${key}' está desativada. Reative-a antes de registrar consentimento para ela.`,
      status: 409,
    });
  }
}
