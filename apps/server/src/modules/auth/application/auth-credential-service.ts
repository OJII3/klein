import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import { accessScopeUserId } from "@shared/access";

import {
  AUTH_DEFAULT_REQUEST_TTL_MINUTES,
  AUTH_MAX_REQUEST_TTL_MINUTES,
  AUTH_SERVICE_PATTERN,
  normalizeAuthLabel,
  validateAuthCredentialFields,
  type AuthCredentialSummary,
  type AuthCredentialValues,
} from "../domain/auth-credential";
import {
  isAuthRequestExpired,
  type AuthRequest,
  type AuthRequestDraft,
} from "../domain/auth-request";
import type { AuthCredentialStore } from "../ports/auth-credential-store";
import type { AuthRequestStore } from "../ports/auth-request-store";

export type AuthRequestOutcome =
  | { readonly kind: "requested"; readonly request: AuthRequest }
  | { readonly kind: "pending"; readonly request: AuthRequest }
  | { readonly kind: "unavailable" }
  | { readonly kind: "invalid"; readonly message: string };

export type AuthPendingLookup =
  | { readonly kind: "pending"; readonly request: AuthRequest }
  | { readonly kind: "expired" }
  | { readonly kind: "missing" };

export type AuthSubmissionOutcome =
  | { readonly kind: "saved"; readonly credential: AuthCredentialSummary }
  | { readonly kind: "cancelled" }
  | { readonly kind: "expired" }
  | { readonly kind: "missing" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * The worker-facing surface. Discord presents the request, the service owns
 * request lifetime and encrypted storage.
 */
export interface AuthCredentialControl {
  request(draft: AuthRequestDraft): Promise<AuthRequestOutcome>;
  lookupPending(requestId: string): Promise<AuthPendingLookup>;
  attachMessage(requestId: string, dmChannelId: string, dmMessageId: string): Promise<void>;
  abandon(requestId: string): Promise<void>;
  complete(
    requestId: string,
    userId: string,
    values: Readonly<Record<string, string>>,
  ): Promise<AuthSubmissionOutcome>;
  cancel(requestId: string, userId: string): Promise<AuthSubmissionOutcome>;
  list(userId: string): Promise<readonly AuthCredentialSummary[]>;
  read(userId: string, service: string): Promise<AuthCredentialValues | undefined>;
}

export interface AuthCredentialServiceDependencies {
  readonly credentials: AuthCredentialStore;
  readonly requests: AuthRequestStore;
  /** Tells the worker that its request was resolved. */
  readonly onResolved?: (request: AuthRequest, outcome: "saved" | "cancelled") => Promise<void>;
  readonly now?: () => Date;
  readonly logger?: Logger;
}

/**
 * Creates pending requests, stores submitted values, and resolves them only
 * for the user who owns the conversation. A missing or expired request never
 * grants access to another user's credentials.
 */
export class AuthCredentialService implements AuthCredentialControl {
  private readonly now: () => Date;

  constructor(private readonly dependencies: AuthCredentialServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    await this.dependencies.requests.load();
    const now = this.now().getTime();
    for (const request of this.dependencies.requests.list()) {
      if (isAuthRequestExpired(request, now)) {
        await this.dependencies.requests.remove(request.requestId);
      }
    }
  }

  async request(draft: AuthRequestDraft): Promise<AuthRequestOutcome> {
    const problem = validateDraft(draft);
    if (problem) return { kind: "invalid", message: problem };

    const existing = this.dependencies.requests
      .list()
      .find(
        (request) =>
          request.userId === draft.userId &&
          request.service === draft.service &&
          request.workerId === draft.workerId,
      );
    if (existing) {
      if (!isAuthRequestExpired(existing, this.now().getTime())) {
        return { kind: "pending", request: existing };
      }
      await this.dependencies.requests.remove(existing.requestId);
    }

    const now = this.now();
    const { expiresInMinutes, ...rest } = draft;
    const request: AuthRequest = {
      requestId: randomUUID(),
      ...rest,
      label: normalizeAuthLabel(rest.label),
      reason: rest.reason.trim(),
      fields: rest.fields.map((field) => ({
        key: field.key,
        label: normalizeAuthLabel(field.label),
      })),
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + (expiresInMinutes ?? AUTH_DEFAULT_REQUEST_TTL_MINUTES) * 60 * 1_000,
      ).toISOString(),
    };
    await this.dependencies.requests.save(request);
    return { kind: "requested", request };
  }

  async lookupPending(requestId: string): Promise<AuthPendingLookup> {
    const request = this.dependencies.requests
      .list()
      .find((candidate) => candidate.requestId === requestId);
    if (!request) return { kind: "missing" };
    if (isAuthRequestExpired(request, this.now().getTime())) {
      await this.dependencies.requests.remove(requestId);
      return { kind: "expired" };
    }
    return { kind: "pending", request };
  }

  async attachMessage(requestId: string, dmChannelId: string, dmMessageId: string): Promise<void> {
    const request = this.dependencies.requests
      .list()
      .find((candidate) => candidate.requestId === requestId);
    if (!request) return;
    await this.dependencies.requests.save({ ...request, dmChannelId, dmMessageId });
  }

  async abandon(requestId: string): Promise<void> {
    await this.dependencies.requests.remove(requestId);
  }

  async complete(
    requestId: string,
    userId: string,
    values: Readonly<Record<string, string>>,
  ): Promise<AuthSubmissionOutcome> {
    const pending = await this.lookupPending(requestId);
    if (pending.kind !== "pending") return { kind: pending.kind };
    if (pending.request.userId !== userId) return { kind: "forbidden" };

    const valueProblem = validateValues(pending.request, values);
    if (valueProblem) return { kind: "invalid", message: valueProblem };

    const credential = await this.dependencies.credentials.save(pending.request.userId, {
      service: pending.request.service,
      label: pending.request.label,
      fields: pending.request.fields,
      values,
      updatedAt: this.now().toISOString(),
    });
    await this.dependencies.requests.remove(requestId);
    await this.notify(pending.request, "saved");
    return { kind: "saved", credential };
  }

  async cancel(requestId: string, userId: string): Promise<AuthSubmissionOutcome> {
    const pending = await this.lookupPending(requestId);
    if (pending.kind !== "pending") return { kind: pending.kind };
    if (pending.request.userId !== userId) return { kind: "forbidden" };

    await this.dependencies.requests.remove(requestId);
    await this.notify(pending.request, "cancelled");
    return { kind: "cancelled" };
  }

  list(userId: string): Promise<readonly AuthCredentialSummary[]> {
    return this.dependencies.credentials.list(userId);
  }

  read(userId: string, service: string): Promise<AuthCredentialValues | undefined> {
    return this.dependencies.credentials.read(userId, service);
  }

  private async notify(request: AuthRequest, outcome: "saved" | "cancelled"): Promise<void> {
    if (!this.dependencies.onResolved) return;
    try {
      await this.dependencies.onResolved(request, outcome);
    } catch (error) {
      this.dependencies.logger?.warn(
        { err: error, event: "auth_request_notification_failed", requestId: request.requestId },
        "Failed to notify the worker that an auth request was resolved",
      );
    }
  }
}

function validateDraft(draft: AuthRequestDraft): string | undefined {
  if (!AUTH_SERVICE_PATTERN.test(draft.service)) {
    return "The service must be 1 to 32 characters of lowercase letters, digits, hyphens, or underscores.";
  }
  if (accessScopeUserId(draft.accessScope) !== draft.userId) {
    return "The request user does not match the conversation scope.";
  }
  if (draft.channelId.length === 0 || draft.workerId.length === 0) {
    return "A request needs a channel and a worker.";
  }

  const label = normalizeAuthLabel(draft.label);
  if (label.length === 0 || label.length > 80) {
    return "The label must be 1 to 80 characters.";
  }
  const reason = draft.reason.trim();
  if (reason.length === 0 || reason.length > 1_500) {
    return "The reason must be 1 to 1500 characters.";
  }

  const fieldProblem = validateAuthCredentialFields(draft.fields);
  if (fieldProblem) return fieldProblem;

  const minutes = draft.expiresInMinutes ?? AUTH_DEFAULT_REQUEST_TTL_MINUTES;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > AUTH_MAX_REQUEST_TTL_MINUTES) {
    return `The expiry must be 1 to ${AUTH_MAX_REQUEST_TTL_MINUTES} minutes.`;
  }
  return undefined;
}

function validateValues(
  request: AuthRequest,
  values: Readonly<Record<string, string>>,
): string | undefined {
  const expected = request.fields.map((field) => field.key).toSorted();
  const actual = Object.keys(values).toSorted();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    return "The submitted fields do not match the request.";
  }
  for (const key of expected) {
    const value = values[key];
    if (typeof value !== "string" || value.length === 0) {
      return `The field ${key} must not be empty.`;
    }
  }
  return undefined;
}
