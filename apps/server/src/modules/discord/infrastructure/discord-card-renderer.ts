import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from "discord.js";

import {
  formatCardBlockText,
  formatCardFooter,
  formatCardHeader,
  type DiscordCard,
  type DiscordCardAccent,
} from "../domain/discord-card";

const ACCENT_COLORS: Readonly<Record<DiscordCardAccent, number>> = {
  neutral: 0x747f8d,
  info: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
};

export interface DiscordCardMessage {
  readonly components: ContainerBuilder[];
  readonly flags: MessageFlags.IsComponentsV2;
}

export function renderDiscordCards(cards: readonly DiscordCard[]): DiscordCardMessage {
  return {
    components: cards.map((card) => renderCard(card)),
    flags: MessageFlags.IsComponentsV2,
  };
}

function renderCard(card: DiscordCard): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(ACCENT_COLORS[card.accent ?? "neutral"]);

  if (card.title !== undefined || card.subtitle !== undefined || card.thumbnail !== undefined) {
    const header = new TextDisplayBuilder().setContent(formatCardHeader(card));
    if (card.thumbnail === undefined) {
      container.addTextDisplayComponents(header);
    } else {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(header)
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(card.thumbnail)),
      );
    }
  }

  for (const block of card.blocks) {
    switch (block.kind) {
      case "media":
        container.addMediaGalleryComponents(
          new MediaGalleryBuilder().addItems(
            ...block.urls.map((url) => {
              const item = new MediaGalleryItemBuilder().setURL(url);
              return block.spoiler === true ? item.setSpoiler(true) : item;
            }),
          ),
        );
        break;
      case "links":
        container.addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            ...block.items.map((item) =>
              new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(item.label).setURL(item.url),
            ),
          ),
        );
        break;
      case "divider":
        container.addSeparatorComponents(
          new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
        );
        break;
      case "text":
      case "fields":
      case "list":
      case "table":
      case "stats":
      case "progress":
      case "callout": {
        const text = formatCardBlockText(block);
        if (text !== undefined) {
          container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
        }
        break;
      }
    }
  }

  if (card.footer !== undefined) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(formatCardFooter(card.footer)),
    );
  }

  return container;
}
