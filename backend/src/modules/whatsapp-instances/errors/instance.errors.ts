import { DomainError } from '../../../shared/errors/domain.error';

export class InstanceNotFoundError extends DomainError {
  constructor(id: string) {
    super({
      code: 'instance.not_found',
      message: `Instance ${id} not found`,
      status: 404,
    });
  }
}

export class InstanceCreationFailedError extends DomainError {
  constructor(cause: string) {
    super({
      code: 'instance.creation_failed',
      message: `Evolution rejected instance creation: ${cause}`,
      status: 502,
    });
  }
}

export class InstanceNameConflictError extends DomainError {
  constructor(name: string) {
    super({
      code: 'instance.name_conflict',
      message: `Instance with evolutionInstanceName='${name}' already exists`,
      status: 409,
    });
  }
}
