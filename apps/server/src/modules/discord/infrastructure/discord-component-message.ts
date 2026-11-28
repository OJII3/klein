import {
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type InteractionReplyOptions,
} from "discord.js";

export type DiscordMessageTone = "neutral" | "success" | "warning" | "danger";

const TONE_ACCENT_COLORS: Readonly<Record<DiscordMessageTone, number>> = {
  neutral: 0x747f8d,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
};

export interface DiscordContainerMessage {
  readonly components: ContainerBuilder[];
  readonly flags: MessageFlags.IsComponentsV2;
}

/** A components v2 interaction reply that only the invoking user can see. */
export interface DiscordEphemeralContainerMessage {
  readonly components: ContainerBuilder[];
  readonly flags: NonNullable<InteractionReplyOptions["flags"]>;
}

export type DiscordInteractionMessage = DiscordContainerMessage | DiscordEphemeralContainerMessage;

export function createTextContainer(text: string, tone?: DiscordMessageTone): ContainerBuilder {
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(text),
  );

  return tone ? container.setAccentColor(TONE_ACCENT_COLORS[tone]) : container;
}
export function createTextContainerMessage(
  text: string,
  tone?: DiscordMessageTone,
): DiscordContainerMessage {
  return { components: [createTextContainer(text, tone)], flags: MessageFlags.IsComponentsV2 };
}

export function createEphemeralTextContainerMessage(
  text: string,
  tone?: DiscordMessageTone,
): DiscordEphemeralContainerMessage {
  return {
    components: [createTextContainer(text, tone)],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}
