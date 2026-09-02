import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { AuthRepository } from './auth.repository';
import { RefreshService } from './refresh.service';
import { InvalidCredentialsError } from './errors/auth.errors';
import { AuditService } from '../../shared/audit/audit.service';
import { NotFoundError } from '../../shared/errors/domain.error';
import type { LoginInput } from '../../schemas/contracts/auth.schema';

export type LoginResult = {
  accessToken: string;
  refreshToken: string;
  // ADVISORY ONLY. `mustChangePassword` is surfaced to the client (the controller
  // returns it in the login payload, and the SPA uses it to force the user to the
  // change-password screen) but it is NOT enforced server-side: a user with the
  // flag set still receives a fully valid access + refresh token and could call
  // any other route directly. Enforcing it would require embedding the flag in the
  // access token and gating every route via a global guard/interceptor; that is
  // explicitly out of scope for this hardening lot, so it stays a UX hint. If a
  // hard server-side block is ever required, do it at the token+guard layer.
  mustChangePassword: boolean;
  user: { id: string; email: string; name: string | null; role: 'ADMIN' | 'OPERATOR' };
};

// Fixed argon2id hash used to equalize login response time when the email maps
// to no user. Without this, the no-user path returns before any argon2.verify,
// so it is measurably faster than the wrong-password path (one argon2 hash),
// letting an attacker enumerate which emails have accounts by timing alone. We
// verify the supplied password against this dummy so both paths spend ~one
// argon2 verify. The plaintext behind it is irrelevant — it never matches a real
// credential and the result is discarded.
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$UM0ORSFAAq1MdFhk6WmsyQ$Q5rCVyCRPpcULlRdNgJP5mWa8Q1MExzawzUqVBMDXnM';

@Injectable()
export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly refresh: RefreshService,
    private readonly audit: AuditService,
  ) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const user = await this.repo.findByEmail(input.email);
    if (!user) {
      // Burn one argon2.verify against a fixed dummy hash so the no-user path
      // takes comparable time to the wrong-password path. The result is always
      // false and is discarded; this only equalizes timing to prevent account
      // enumeration via a response-time side channel.
      await argon2.verify(DUMMY_PASSWORD_HASH, input.password);
      await this.audit.log('auth.login_failed', 'User', undefined, {
        email: input.email,
        reason: 'user_not_found',
      });
      throw new InvalidCredentialsError();
    }

    const ok = await argon2.verify(user.password, input.password);
    if (!ok) {
      await this.audit.log('auth.login_failed', 'User', user.id, {
        email: input.email,
        reason: 'wrong_password',
      });
      throw new InvalidCredentialsError();
    }

    const { accessToken, refreshToken } = await this.refresh.issueNew(
      user.id,
      user.email,
      user.role,
    );

    await this.repo.updateLastLoginAt(user.id);
    await this.audit.log('auth.login_success', 'User', user.id);

    return {
      accessToken,
      refreshToken,
      mustChangePassword: user.mustChangePassword,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  }

  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    const user = await this.repo.findById(userId);
    if (!user) {
      throw new NotFoundError('User', userId);
    }

    const ok = await argon2.verify(user.password, input.currentPassword);
    if (!ok) {
      throw new InvalidCredentialsError();
    }

    const newHash = await argon2.hash(input.newPassword, { type: argon2.argon2id });
    await this.repo.updatePassword(userId, newHash, true);
    // Invalidate every existing session: a stolen refresh token must not keep
    // rotating after the credential it was minted under has changed.
    await this.refresh.revokeAllForUser(userId);
    await this.audit.log('auth.password_changed', 'User', userId);
  }
}
