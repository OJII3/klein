import type { AccessScope } from "@shared/access";

import type { SecretField } from "./secret";

/** A pending request to the linked user for secrets. */
export interface SecretRequest {
  readonly requestId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly accessScope: AccessScope;
  readonly workerId: string;
  readonly service: string;
  readonly label: string;
  readonly reason: string;
  readonly fields: readonly SecretField[];
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Set after the direct message is sent, so later outcomes can edit it. */
  readonly dmChannelId?: string;
  readonly dmMessageId?: string;
}

export interface SecretRequestDraft {
  readonly userId: string;
  readonly channelId: string;
  readonly accessScope: AccessScope;
  readonly workerId: string;
  readonly service: string;
  readonly label: string;
  readonly reason: string;
  readonly fields: readonly SecretField[];
  readonly expiresInMinutes?: number;
}

export function isSecretRequestExpired(request: SecretRequest, now = Date.now()): boolean {
  const expiresAt = Date.parse(request.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}
