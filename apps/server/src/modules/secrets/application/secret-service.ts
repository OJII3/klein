import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import { accessScopeUserId } from "@shared/access";

import {
  SECRET_DEFAULT_REQUEST_TTL_MINUTES,
  SECRET_MAX_REQUEST_TTL_MINUTES,
  SECRET_SERVICE_PATTERN,
  normalizeSecretLabel,
  validateSecretFields,
  type SecretSummary,
  type SecretValues,
} from "../domain/secret";
import {
  isSecretRequestExpired,
  type SecretRequest,
  type SecretRequestDraft,
} from "../domain/secret-request";
import type { SecretStore } from "../ports/secret-store";
import type { SecretRequestStore } from "../ports/secret-request-store";

export type SecretRequestOutcome =
  | { readonly kind: "requested"; readonly request: SecretRequest }
  | { readonly kind: "pending"; readonly request: SecretRequest }
  | { readonly kind: "unavailable" }
  | { readonly kind: "invalid"; readonly message: string };

export type SecretPendingLookup =
  | { readonly kind: "pending"; readonly request: SecretRequest }
  | { readonly kind: "expired" }
  | { readonly kind: "missing" };

export type SecretSubmissionOutcome =
  | { readonly kind: "saved"; readonly secret: SecretSummary }
  | { readonly kind: "cancelled" }
  | { readonly kind: "expired" }
  | { readonly kind: "missing" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "invalid"; readonly message: string };

export interface SecretControl {
  request(draft: SecretRequestDraft): Promise<SecretRequestOutcome>;
  lookupPending(requestId: string): Promise<SecretPendingLookup>;
  attachMessage(requestId: string, dmChannelId: string, dmMessageId: string): Promise<void>;
  abandon(requestId: string): Promise<void>;
  complete(
    requestId: string,
    userId: string,
    values: Readonly<Record<string, string>>,
  ): Promise<SecretSubmissionOutcome>;
  cancel(requestId: string, userId: string): Promise<SecretSubmissionOutcome>;
  list(userId: string): Promise<readonly SecretSummary[]>;
  read(userId: string, service: string): Promise<SecretValues | undefined>;
  delete(userId: string, service: string): Promise<boolean>;
}

export interface SecretServiceDependencies {
  readonly secrets: SecretStore;
  readonly requests: SecretRequestStore;
  readonly onResolved?: (request: SecretRequest, outcome: "saved" | "cancelled") => Promise<void>;
  readonly now?: () => Date;
  readonly logger?: Logger;
}

/**
 * Creates pending requests, stores submitted values, and resolves them only
 * for the user who owns the conversation. A missing or expired request never
 * grants access to another user's secrets.
 */
export class SecretService implements SecretControl {
  private readonly now: () => Date;

  constructor(private readonly dependencies: SecretServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    await this.dependencies.requests.load();
    const now = this.now().getTime();
    for (const request of this.dependencies.requests.list()) {
      if (isSecretRequestExpired(request, now)) {
        await this.dependencies.requests.remove(request.requestId);
      }
    }
  }

  async request(draft: SecretRequestDraft): Promise<SecretRequestOutcome> {
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
      if (!isSecretRequestExpired(existing, this.now().getTime())) {
        return { kind: "pending", request: existing };
      }
      await this.dependencies.requests.remove(existing.requestId);
    }

    const now = this.now();
    const { expiresInMinutes, ...rest } = draft;
    const request: SecretRequest = {
      requestId: randomUUID(),
      ...rest,
      label: normalizeSecretLabel(rest.label),
      reason: rest.reason.trim(),
      fields: rest.fields.map((field) => {
        const normalizedField: { key: string; label: string; env?: string } = {
          key: field.key,
          label: normalizeSecretLabel(field.label),
        };
        if (field.env !== undefined) normalizedField.env = field.env;
        return normalizedField;
      }),
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + (expiresInMinutes ?? SECRET_DEFAULT_REQUEST_TTL_MINUTES) * 60 * 1_000,
      ).toISOString(),
    };
    await this.dependencies.requests.save(request);
    return { kind: "requested", request };
  }

  async lookupPending(requestId: string): Promise<SecretPendingLookup> {
    const request = this.dependencies.requests
      .list()
      .find((candidate) => candidate.requestId === requestId);
    if (!request) return { kind: "missing" };
    if (isSecretRequestExpired(request, this.now().getTime())) {
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
  ): Promise<SecretSubmissionOutcome> {
    const pending = await this.lookupPending(requestId);
    if (pending.kind !== "pending") return { kind: pending.kind };
    if (pending.request.userId !== userId) return { kind: "forbidden" };

    const valueProblem = validateValues(pending.request, values);
    if (valueProblem) return { kind: "invalid", message: valueProblem };

    const secret = await this.dependencies.secrets.save(pending.request.userId, {
      service: pending.request.service,
      label: pending.request.label,
      fields: pending.request.fields,
      values,
      updatedAt: this.now().toISOString(),
    });
    await this.dependencies.requests.remove(requestId);
    await this.notify(pending.request, "saved");
    return { kind: "saved", secret };
  }

  async cancel(requestId: string, userId: string): Promise<SecretSubmissionOutcome> {
    const pending = await this.lookupPending(requestId);
    if (pending.kind !== "pending") return { kind: pending.kind };
    if (pending.request.userId !== userId) return { kind: "forbidden" };

    await this.dependencies.requests.remove(requestId);
    await this.notify(pending.request, "cancelled");
    return { kind: "cancelled" };
  }

  list(userId: string): Promise<readonly SecretSummary[]> {
    return this.dependencies.secrets.list(userId);
  }

  read(userId: string, service: string): Promise<SecretValues | undefined> {
    return this.dependencies.secrets.read(userId, service);
  }

  delete(userId: string, service: string): Promise<boolean> {
    return this.dependencies.secrets.delete(userId, service);
  }

  private async notify(request: SecretRequest, outcome: "saved" | "cancelled"): Promise<void> {
    if (!this.dependencies.onResolved) return;
    try {
      await this.dependencies.onResolved(request, outcome);
    } catch (error) {
      this.dependencies.logger?.warn(
        { err: error, event: "secret_request_notification_failed", requestId: request.requestId },
        "Failed to notify the worker that an secret request was resolved",
      );
    }
  }
}

function validateDraft(draft: SecretRequestDraft): string | undefined {
  if (!SECRET_SERVICE_PATTERN.test(draft.service)) {
    return "The service must be 1 to 32 characters of lowercase letters, digits, hyphens, or underscores.";
  }
  if (accessScopeUserId(draft.accessScope) !== draft.userId) {
    return "The request user does not match the conversation scope.";
  }
  if (draft.channelId.length === 0 || draft.workerId.length === 0) {
    return "A request needs a channel and a worker.";
  }

  const label = normalizeSecretLabel(draft.label);
  if (label.length === 0 || label.length > 80) {
    return "The label must be 1 to 80 characters.";
  }
  const reason = draft.reason.trim();
  if (reason.length === 0 || reason.length > 1_500) {
    return "The reason must be 1 to 1500 characters.";
  }

  const fieldProblem = validateSecretFields(draft.fields);
  if (fieldProblem) return fieldProblem;

  const minutes = draft.expiresInMinutes ?? SECRET_DEFAULT_REQUEST_TTL_MINUTES;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > SECRET_MAX_REQUEST_TTL_MINUTES) {
    return `The expiry must be 1 to ${SECRET_MAX_REQUEST_TTL_MINUTES} minutes.`;
  }
  return undefined;
}

function validateValues(
  request: SecretRequest,
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
