import type { AccessScope } from "@shared/access";

import type { AuthCredentialField } from "./auth-credential";

/** A pending request to the linked user for credentials. */
export interface AuthRequest {
  readonly requestId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly accessScope: AccessScope;
  readonly workerId: string;
  readonly service: string;
  readonly label: string;
  readonly reason: string;
  readonly fields: readonly AuthCredentialField[];
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Set after the direct message is sent, so later outcomes can edit it. */
  readonly dmChannelId?: string;
  readonly dmMessageId?: string;
}

export interface AuthRequestDraft {
  readonly userId: string;
  readonly channelId: string;
  readonly accessScope: AccessScope;
  readonly workerId: string;
  readonly service: string;
  readonly label: string;
  readonly reason: string;
  readonly fields: readonly AuthCredentialField[];
  readonly expiresInMinutes?: number;
}

export function isAuthRequestExpired(request: AuthRequest, now = Date.now()): boolean {
  const expiresAt = Date.parse(request.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}
