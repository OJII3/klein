import type { DiscordOperatingMode } from "../domain/discord-operating-state";

export type DiscordOperatingModeCommandRejection = "guild-only" | "missing-permission";

export type DiscordOperatingModeCommandResult =
  | { readonly kind: "ignored" }
  | { readonly kind: "rejected"; readonly reason: DiscordOperatingModeCommandRejection }
  | { readonly kind: "changed"; readonly mode: DiscordOperatingMode };

export interface DiscordOperatingModeCommandInput {
  readonly subcommand: string;
  readonly inGuild: boolean;
  readonly canManageGuild: boolean;
}

/**
 * Decides the effect of the `/status` subcommands. The caller reports whether
 * the interaction happened in a guild and whether its member may manage the
 * guild.
 */
export function decideDiscordOperatingModeCommand(
  input: DiscordOperatingModeCommandInput,
): DiscordOperatingModeCommandResult {
  const mode =
    input.subcommand === "idle"
      ? ("paused" as const)
      : input.subcommand === "online"
        ? ("active" as const)
        : undefined;
  if (!mode) return { kind: "ignored" };
  if (!input.inGuild) return { kind: "rejected", reason: "guild-only" };
  if (!input.canManageGuild) return { kind: "rejected", reason: "missing-permission" };
  return { kind: "changed", mode };
}
