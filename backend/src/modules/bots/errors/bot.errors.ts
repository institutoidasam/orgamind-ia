import { DomainError } from '../../../shared/errors/domain.error';

export class BotNotFoundError extends DomainError {
  constructor(id: string) {
    super({ code: 'bot.not_found', message: `Bot ${id} not found`, status: 404 });
  }
}

export class DifyConsoleNotConfiguredError extends DomainError {
  constructor() {
    super({ code: 'dify.console_not_configured', message: 'DIFY_CONSOLE_* não configurado', status: 503 });
  }
}

export class BotAppNotFoundError extends DomainError {
  constructor(appId: string) {
    super({ code: 'bot.app_not_found', message: `App Dify ${appId} não encontrado`, status: 404 });
  }
}

export class BotKeyUnavailableError extends DomainError {
  constructor(appId: string) {
    super({ code: 'bot.key_unavailable', message: `Não foi possível obter uma API key para o app Dify ${appId}`, status: 502 });
  }
}
