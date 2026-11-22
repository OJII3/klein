import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AuthCredentialControl } from "@modules/auth/application/auth-credential-service";
import {
  AUTH_FIELD_KEY_PATTERN,
  AUTH_SERVICE_PATTERN,
  authEnvironmentVariableName,
  type AuthCredentialSummary,
} from "@modules/auth/domain/auth-credential";
import type { AccessScope } from "@shared/access";
import type { UserEnvironment } from "@shared/user-environment";

export interface AuthCommandOptions {
  readonly timeoutSeconds?: number;
  readonly signal?: AbortSignal;
  readonly credentialEnvironment?: Readonly<Record<string, string>>;
}

export interface AuthCommandResult {
  readonly output: string;
  readonly exitCode: number | null;
  readonly truncated: boolean;
}

/** Runs a command inside the linked user's sandbox. */
export type AuthCommandRunner = (
  environment: UserEnvironment,
  command: string,
  options: AuthCommandOptions,
) => Promise<AuthCommandResult>;

export interface AuthToolDependencies {
  readonly credentials: Pick<AuthCredentialControl, "request" | "list" | "read">;
  readonly userId: string;
  readonly channelId: string;
  readonly accessScope: AccessScope;
  readonly workerId: string;
  readonly environment: UserEnvironment;
  readonly runCommand: AuthCommandRunner;
}

interface AuthRequestToolDetails {
  readonly status: "requested" | "pending" | "unavailable";
  readonly requestId?: string;
}

/**
 * Worker tools for the linked user's credential vault. The requester never
 * sees a typed secret: only `auth_run` receives the decrypted values, and it
 * passes them to the sandbox environment rather than the model.
 */
export function createAuthTools(dependencies: AuthToolDependencies): readonly ToolDefinition[] {
  return [
    defineTool({
      name: "auth_request",
      label: "Request Credentials",
      description:
        "Ask the linked Discord user for credentials by direct message. The user gets a Components v2 request with a button and a modal; the values are encrypted and saved without entering this conversation. " +
        "Use this only for a service the task genuinely needs. The request expires after 15 minutes unless expiresInMinutes is set (maximum 60). " +
        "When the user submits or cancels, you receive a new message. Never ask for a password, token, or other secret in your result.",
      parameters: Type.Object({
        service: Type.String({
          minLength: 1,
          maxLength: 32,
          pattern: AUTH_SERVICE_PATTERN.source,
        }),
        label: Type.String({ minLength: 1, maxLength: 80 }),
        reason: Type.String({ minLength: 1, maxLength: 1_500 }),
        fields: Type.Array(
          Type.Object(
            {
              key: Type.String({
                minLength: 1,
                maxLength: 32,
                pattern: AUTH_FIELD_KEY_PATTERN.source,
              }),
              label: Type.String({ minLength: 1, maxLength: 45 }),
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
        details: AuthRequestToolDetails;
      }> {
        const outcome = await dependencies.credentials.request({
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
                    `Sent a credential request for ${params.service} to the linked user by direct message. ` +
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
                    `A credential request for ${params.service} is already pending with the linked user. ` +
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
        throw new Error("Unhandled auth request outcome.");
      },
    }),
    defineTool({
      name: "auth_list",
      label: "List Credentials",
      description:
        "List the linked user's saved credentials with their service, label, field names, and update time. Values are never shown; use auth_run to use a credential.",
      parameters: Type.Object({}),
      exposure: "deferred",
      async execute() {
        const credentials = await dependencies.credentials.list(dependencies.userId);
        return {
          content: [
            {
              type: "text",
              text:
                credentials.length === 0
                  ? "No credentials are saved for this user. Use auth_request to ask for one."
                  : credentials.map((credential) => formatCredentialLine(credential)).join("\n"),
            },
          ],
          details: { services: credentials.map((credential) => credential.service) },
        };
      },
    }),
    defineTool({
      name: "auth_run",
      label: "Run with Credentials",
      description:
        "Run a command in the linked user's sandbox with a saved credential injected as environment variables named KLEIN_AUTH_<SERVICE>_<FIELD> (uppercase). " +
        "The values never appear in the tool result; printed secrets are redacted. Use auth_list first to see which services exist and the exact variable names. " +
        "The command runs with the same sandbox and timeout rules as bash, and its output is limited to 32 KiB.",
      parameters: Type.Object({
        service: Type.String({
          minLength: 1,
          maxLength: 32,
          pattern: AUTH_SERVICE_PATTERN.source,
        }),
        command: Type.String({ minLength: 1, maxLength: 20_000 }),
        timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 3_600 })),
      }),
      exposure: "deferred",
      async execute(_toolCallId, params, signal) {
        const credential = await dependencies.credentials.read(dependencies.userId, params.service);
        if (!credential) {
          throw new Error(
            `No credentials are saved for ${params.service}. Use auth_list to see saved services or auth_request to ask the user.`,
          );
        }

        const environment: Record<string, string> = {};
        for (const field of credential.fields) {
          const value = credential.values[field.key];
          if (value === undefined) {
            throw new Error(`The credential for ${params.service} is missing ${field.key}.`);
          }
          environment[authEnvironmentVariableName(params.service, field.key)] = value;
        }

        const result = await dependencies.runCommand(dependencies.environment, params.command, {
          credentialEnvironment: environment,
          ...(params.timeout !== undefined ? { timeoutSeconds: params.timeout } : {}),
          ...(signal ? { signal } : {}),
        });
        return formatRunResult(params.service, credential, environment, result);
      },
    }),
  ];
}

function formatRunResult(
  service: string,
  credential: AuthCredentialSummary,
  environment: Readonly<Record<string, string>>,
  result: AuthCommandResult,
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
  const output = redactCredentialValues(result.output.trimEnd(), Object.values(environment));
  const text = [
    `Injected ${credential.label} (${service}) as ${names.join(", ")}. The values are not shown.`,
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

function formatCredentialLine(credential: AuthCredentialSummary): string {
  const fields = credential.fields
    .map(
      (field) =>
        `${field.key} (${field.label}) -> ${authEnvironmentVariableName(credential.service, field.key)}`,
    )
    .join(", ");
  return `- ${credential.service}: ${credential.label}; fields: ${fields}; updated: ${credential.updatedAt}`;
}

/** Defense against a command that prints an injected value. */
function redactCredentialValues(output: string, values: readonly string[]): string {
  let redacted = output;
  for (const value of values) {
    if (value.length < 4) continue;
    redacted = redacted.replaceAll(value, "[redacted]");
  }
  return redacted;
}
