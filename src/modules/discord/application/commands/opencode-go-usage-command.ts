import type { GetMonthlyUsageLimit } from "../../../usage/application/get-monthly-usage-limit.js";
import type { DiscordSlashCommandHandler } from "../../ports/discord-service.js";
import type { DiscordSlashCommand } from "./discord-slash-command-router.js";

export const OPENCODE_GO_USAGE_COMMAND_NAME = "usage";

export const OPENCODE_GO_USAGE_COMMAND_DEFINITION = {
  description: "OpenCode Go の月間使用量を確認する",
  name: OPENCODE_GO_USAGE_COMMAND_NAME,
} as const;

function formatPercentage(value: number): string {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

function formatResetDate(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(date);
}

export function createOpenCodeGoUsageCommand(
  getMonthlyUsageLimit: GetMonthlyUsageLimit,
): DiscordSlashCommand {
  const handler: DiscordSlashCommandHandler = async (interaction) => {
    await interaction.deferReply({ ephemeral: true });
    const monthly = await getMonthlyUsageLimit();
    const status = monthly.status === "rate-limited" ? "\n状態: リミット到達" : "";

    await interaction.editReply(
      [
        "OpenCode Go 月間使用量",
        `使用率: ${formatPercentage(monthly.usedPercentage)}`,
        `リセット: ${formatResetDate(monthly.resetsAt)} (JST)`,
        status,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  };

  return {
    ...OPENCODE_GO_USAGE_COMMAND_DEFINITION,
    handler,
  };
}
