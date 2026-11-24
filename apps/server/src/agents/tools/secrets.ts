import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { SecretControl } from "@modules/secrets/application/secret-service";
import {
  SECRET_ENVIRONMENT_ALIAS_PATTERN,
  SECRET_FIELD_KEY_PATTERN,
  SECRET_SERVICE_PATTERN,
  secretEnvironmentVariableName,
  type SecretSummary,
} from "@modules/secrets/domain/secret";
import type { AccessScope } from "@shared/access";

export interface SecretCommandOptions {
  readonly timeoutSeconds?: number;
  readonly signal?: AbortSignal;
  readonly secretEnvironment?: Readonly<Record<string, string>>;
}

export interface SecretCommandResult {
  readonly output: string;
  readonly exitCode: number | null;
  readonly truncated: boolean;
}

export type SecretCommandRunner = (
  command: string,
  options: SecretCommandOptions,
) => Promise<SecretCommandResult>;

export interface SecretToolDependencies {
  readonly secrets: Pick<SecretControl, "request" | "list" | "read" | "delete">;
  readonly userId: string;
  readonly channelId: string;
  readonly accessScope: AccessScope;
  readonly workerId: string;
  readonly runCommand: SecretCommandRunner;
}

interface SecretRequestToolDetails {
  readonly status: "requested" | "pending" | "unavailable";
  readonly requestId?: string;
}

export function createSecretTools(dependencies: SecretToolDependencies): readonly ToolDefinition[] {
  return [
    defineTool({
      name: "secret_request",
      label: "Request Secrets",
      description:
        "Ask the linked Discord user for secrets by direct message. The user gets a Components v2 request with a button and a modal; the values are encrypted and saved without entering this conversation. " +
        "Use this only for a service the task genuinely needs. The request expires after 15 minutes unless expiresInMinutes is set (maximum 60). " +
        "When the user submits or cancels, you receive a new message. Never ask for a password, token, or other secret in your result.",
      parameters: Type.Object({
        service: Type.String({
          minLength: 1,
          maxLength: 32,
          pattern: SECRET_SERVICE_PATTERN.source,
        }),
        label: Type.String({ minLength: 1, maxLength: 80 }),
        reason: Type.String({ minLength: 1, maxLength: 1_500 }),
        fields: Type.Array(
          Type.Object(
            {
              key: Type.String({
                minLength: 1,
                maxLength: 32,
                pattern: SECRET_FIELD_KEY_PATTERN.source,
              }),
              label: Type.String({ minLength: 1, maxLength: 45 }),
              env: Type.Optional(
                Type.String({
                  minLength: 1,
                  maxLength: 64,
                  pattern: SECRET_ENVIRONMENT_ALIAS_PATTERN.source,
                }),
              ),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 5 },
        ),
        expiresInMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
      }),
      exposure: "deferred",
      async execute(
        _toolCallId,
        params,
      ): Promise<{
        content: { type: "text"; text: string }[];
        details: SecretRequestToolDetails;
      }> {
        const outcome = await dependencies.secrets.request({
          userId: dependencies.userId,
          channelId: dependencies.channelId,
          accessScope: dependencies.accessScope,
          workerId: dependencies.workerId,
          service: params.service,
          label: params.label,
          reason: params.reason,
          fields: params.fields,
          ...(params.expiresInMinutes !== undefined
            ? { expiresInMinutes: params.expiresInMinutes }
            : {}),
        });
        switch (outcome.kind) {
          case "requested":
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Sent a secret request for ${params.service} to the linked user by direct message. ` +
                    "You will receive a new message when the user submits or cancels. Do not ask again or wait in this turn.",
                },
              ],
              details: { requestId: outcome.request.requestId, status: "requested" },
            };
          case "pending":
            return {
              content: [
                {
                  type: "text",
                  text:
                    `A secret request for ${params.service} is already pending with the linked user. ` +
                    "Wait for the user to submit or cancel it.",
                },
              ],
              details: { requestId: outcome.request.requestId, status: "pending" },
            };
          case "unavailable":
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Could not send a direct message to the linked user. They may have direct messages disabled. " +
                    "Report this to the conversation agent instead of asking for the secret in the channel.",
                },
              ],
              details: { status: "unavailable" },
            };
          case "invalid":
            throw new Error(outcome.message);
        }
        throw new Error("Unhandled secret request outcome.");
      },
    }),
    defineTool({
      name: "secret_list",
      label: "List Secrets",
      description:
        "List the linked user's saved secrets with their service, label, field names, and update time. Values are never shown; use secret_run to use a secret.",
      parameters: Type.Object({}),
      exposure: "deferred",
      async execute() {
        const secrets = await dependencies.secrets.list(dependencies.userId);
        return {
          content: [
            {
              type: "text",
              text:
                secrets.length === 0
                  ? "No secrets are saved for this user. Use secret_request to ask for one."
                  : secrets.map((secret) => formatSecretLine(secret)).join("\n"),
            },
          ],
          details: { services: secrets.map((secret) => secret.service) },
        };
      },
    }),
    defineTool({
      name: "secret_run",
      label: "Run with Secrets",
      description:
        "Run a command with a saved secret injected as environment variables named KLEIN_SECRET_<SERVICE>_<FIELD> (uppercase). " +
        "The values never appear in the tool result; printed secrets are redacted. Use secret_list first to see which services exist and the exact variable names. " +
        "This is for API tokens and already-issued access tokens. Do not use it to create long-lived OAuth state in the shell; OAuth config folders written there are readable by the worker. " +
        "The command runs with the same shell and timeout rules as bash, and its output is limited to 32 KiB.",
      parameters: Type.Object({
        service: Type.String({
          minLength: 1,
          maxLength: 32,
          pattern: SECRET_SERVICE_PATTERN.source,
        }),
        command: Type.String({ minLength: 1, maxLength: 20_000 }),
        timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 3_600 })),
      }),
      exposure: "deferred",
      async execute(_toolCallId, params, signal) {
        const secret = await dependencies.secrets.read(dependencies.userId, params.service);
        if (!secret) {
          throw new Error(
            `No secrets are saved for ${params.service}. Use secret_list to see saved services or secret_request to ask the user.`,
          );
        }

        const environment: Record<string, string> = {};
        for (const field of secret.fields) {
          const value = secret.values[field.key];
          if (value === undefined) {
            throw new Error(`The secret for ${params.service} is missing ${field.key}.`);
          }
          environment[secretEnvironmentVariableName(params.service, field.key)] = value;
          if (field.env) environment[field.env] = value;
        }

        const result = await dependencies.runCommand(params.command, {
          secretEnvironment: environment,
          ...(params.timeout !== undefined ? { timeoutSeconds: params.timeout } : {}),
          ...(signal ? { signal } : {}),
        });
        return formatRunResult(params.service, secret, environment, result);
      },
    }),
    defineTool({
      name: "secret_delete",
      label: "Delete Secrets",
      description:
        "Permanently delete the saved secrets for a service. Use this only when the user explicitly asks to remove or revoke a saved secret.",
      parameters: Type.Object({
        service: Type.String({
          minLength: 1,
          maxLength: 32,
          pattern: SECRET_SERVICE_PATTERN.source,
        }),
      }),
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const deleted = await dependencies.secrets.delete(dependencies.userId, params.service);
        return {
          content: [
            {
              type: "text",
              text: deleted
                ? `Deleted the saved secrets for ${params.service}.`
                : `No saved secrets for ${params.service} were found.`,
            },
          ],
          details: { service: params.service, deleted },
        };
      },
    }),
  ];
}

function formatRunResult(
  service: string,
  secret: SecretSummary,
  environment: Readonly<Record<string, string>>,
  result: SecretCommandResult,
): {
  content: { type: "text"; text: string }[];
  details: {
    service: string;
    environmentVariables: string[];
    exitCode: number | null;
    truncated: boolean;
  };
} {
  const names = Object.keys(environment);
  const output = redactSecretValues(result.output.trimEnd(), Object.values(environment));
  const text = [
    `Injected ${secret.label} (${service}) as ${names.join(", ")}. The values are not shown.`,
    `exit code: ${result.exitCode ?? "unknown"}`,
    output.length > 0 ? output : "(no output)",
    ...(result.truncated ? ["[output truncated]"] : []),
  ].join("\n\n");

  return {
    content: [{ type: "text", text }],
    details: {
      service,
      environmentVariables: names,
      exitCode: result.exitCode,
      truncated: result.truncated,
    },
  };
}

function formatSecretLine(secret: SecretSummary): string {
  const fields = secret.fields
    .map((field) => {
      const canonical = secretEnvironmentVariableName(secret.service, field.key);
      const alias = field.env ? `, ${field.env}` : "";
      return `${field.key} (${field.label}) -> ${canonical}${alias}`;
    })
    .join(", ");
  return `- ${secret.service}: ${secret.label}; fields: ${fields}; updated: ${secret.updatedAt}`;
}

/** Defense against a command that prints an injected value. */
function redactSecretValues(output: string, values: readonly string[]): string {
  let redacted = output;
  for (const value of values) {
    if (value.length < 4) continue;
    redacted = redacted.replaceAll(value, "[redacted]");
  }
  return redacted;
}
