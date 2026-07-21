import { AccountType } from '../api/contracts';

/**
 * Client-side auth vocabulary, shared by both adapters (mock + Cognito), the
 * AuthService facade and the /account UI. Angular-free on purpose — the
 * external backend vendors PASSWORD_POLICY so the real user pool follows the
 * exact same rules the mock and UI enforce.
 */

export interface AuthUser {
  userId: string;
  username: string;
  /** Minors are username-only — their guardian is the recovery channel. */
  email: string | null;
  displayName: string | null;
  /** Hint from the token claim. Authorization truth is GET /me, never this. */
  accountType: AccountType;
}

export interface AuthSession {
  user: AuthUser;
  issuedAt: number;
}

/** What a flow call resolved to — the /account state machine switches on it. */
export type AuthNext =
  | { kind: 'done'; session: AuthSession }
  | { kind: 'confirmSignUp'; username: string; deliveryHint: string | null }
  /** Guardian-created minor signing in with their temp password. */
  | { kind: 'newPasswordRequired' };

export type AuthErrorCode =
  | 'wrongCredentials'
  | 'userNotFound'
  | 'userExists'
  | 'codeMismatch'
  | 'codeExpired'
  | 'passwordPolicy'
  | 'tooManyAttempts'
  /** Includes SRP clock-skew failures — surfaced with a "device clock" hint. */
  | 'network'
  | 'unknown';

/** Adapters throw these; the facade converts them into signal VALUES —
 *  components never see exceptions. */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AuthError';
  }
}

/**
 * One policy, three enforcers: the mock rejects on it, the UI hints with it,
 * and the CDK stack configures the Cognito pool FROM it. Align the pool to
 * this const, never the other way around.
 */
export const PASSWORD_POLICY = Object.freeze({
  minLength: 8,
  requireLower: true,
  requireUpper: true,
  requireDigit: true,
});

export function passwordMeetsPolicy(password: string): boolean {
  return (
    password.length >= PASSWORD_POLICY.minLength &&
    (!PASSWORD_POLICY.requireLower || /[a-z]/.test(password)) &&
    (!PASSWORD_POLICY.requireUpper || /[A-Z]/.test(password)) &&
    (!PASSWORD_POLICY.requireDigit || /\d/.test(password))
  );
}

export const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

// ── Device-local meta-store keys (see the map in core/db/schema.ts) ─────────

/** Cached identity snapshot — hydrates the session at boot with zero network. */
export const META_AUTH_IDENTITY = 'auth.identity';
/** "This device's forest belongs to account X" — written ONLY by the explicit
 *  connect-my-forest action (phase «conectar mi bosque»). */
export const META_ACCOUNT_LINK = 'account.link';

export interface AuthIdentitySnapshot {
  key: typeof META_AUTH_IDENTITY;
  /** null = explicitly signed out (the row outlives the session on purpose). */
  user: AuthUser | null;
  cachedAt: number;
}

export interface AccountLinkSnapshot {
  key: typeof META_ACCOUNT_LINK;
  /** null = explicitly disconnected (the row outlives the link on purpose). */
  accountId: string | null;
  linkedAt: number;
  /** When the first full push completed — null until the connect finishes. */
  uploadedAt: number | null;
}
