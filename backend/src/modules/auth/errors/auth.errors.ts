import { UnauthorizedError } from '../../../shared/errors/domain.error';

export class InvalidCredentialsError extends UnauthorizedError {
  constructor() {
    super('Invalid credentials', 'auth.invalid_credentials');
  }
}
