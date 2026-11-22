import type { DiscordChannelRuleStore } from "../ports/discord-channel-rule-store";

export type DiscordChannelRuleCommandRejection =
  "guild-only" | "missing-permission" | "unknown-channel";

export type DiscordChannelRuleEditResult =
  | { readonly kind: "rejected"; readonly reason: DiscordChannelRuleCommandRejection }
  | { readonly kind: "editable"; readonly rule?: string };

export type DiscordChannelRuleEditOutcome =
  | { readonly kind: "rejected"; readonly reason: DiscordChannelRuleCommandRejection }
  | { readonly kind: "saved" }
  | { readonly kind: "deleted" };

export interface DiscordChannelRuleCommandTarget {
  readonly inGuild: boolean;
  readonly canUseApplicationCommands: boolean;
  readonly guildId?: string;
  readonly channelId?: string;
}

type ResolvedTarget = {
  readonly kind: "resolved";
  readonly guildId: string;
  readonly channelId: string;
};

type TargetRejection = {
  readonly kind: "rejected";
  readonly reason: DiscordChannelRuleCommandRejection;
};

export class DiscordChannelRuleCommand {
  constructor(private readonly store?: Pick<DiscordChannelRuleStore, "get" | "set">) {}

  async getRuleForEdit(
    target: DiscordChannelRuleCommandTarget,
  ): Promise<DiscordChannelRuleEditResult> {
    const resolved = this.resolveTarget(target);
    if (resolved.kind === "rejected") return resolved;

    const rule = await this.store?.get(resolved.guildId, resolved.channelId);
    return rule === undefined ? { kind: "editable" } : { kind: "editable", rule };
  }

  async applyRuleEdit(
    target: DiscordChannelRuleCommandTarget,
    ruleText: string,
  ): Promise<DiscordChannelRuleEditOutcome> {
    const resolved = this.resolveTarget(target);
    if (resolved.kind === "rejected") return resolved;

    await this.store?.set(resolved.guildId, resolved.channelId, ruleText);
    return { kind: ruleText.trim() ? "saved" : "deleted" };
  }

  private resolveTarget(target: DiscordChannelRuleCommandTarget): ResolvedTarget | TargetRejection {
    if (!target.inGuild) return { kind: "rejected", reason: "guild-only" };
    if (!target.canUseApplicationCommands) {
      return { kind: "rejected", reason: "missing-permission" };
    }

    const { guildId, channelId } = target;
    if (!guildId || !channelId) return { kind: "rejected", reason: "unknown-channel" };
    return { kind: "resolved", guildId, channelId };
  }
}
