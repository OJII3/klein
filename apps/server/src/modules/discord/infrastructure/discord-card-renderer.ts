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

import { formatCardTexts, type DiscordCard, type DiscordCardAccent } from "../domain/discord-card";

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
  const texts = formatCardTexts(card);

  if (texts.header !== undefined) {
    const header = new TextDisplayBuilder().setContent(texts.header);
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

  for (const [blockIndex, block] of card.blocks.entries()) {
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
        const text = texts.blocks[blockIndex];
        if (text !== undefined) {
          container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
        }
        break;
      }
    }
  }

  if (texts.footer !== undefined) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(texts.footer));
  }

  return container;
}
