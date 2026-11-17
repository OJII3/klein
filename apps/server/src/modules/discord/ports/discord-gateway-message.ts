import type {
  DiscordImageAttachment,
  DiscordMessage,
  DiscordReplyReference,
} from "../domain/discord-message";

export interface DiscordGatewayUser {
  readonly bot: boolean;
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
}

export interface DiscordGatewayAttachment {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly url: string;
  readonly contentType: string | null;
}

export interface DiscordGatewayChannel {
  readonly id: string;
  readonly name?: string | null;
  readonly parentId?: string | null;
  isThread(): boolean;
}

/** The message shape a gateway adapter provides to the ingestion logic. */
export interface DiscordGatewayMessage {
  readonly id: string;
  readonly channelId: string;
  readonly guildId: string | null;
  readonly content: string;
  readonly createdAt: Date;
  readonly author: DiscordGatewayUser;
  readonly member?: { readonly displayName: string } | null;
  readonly channel: DiscordGatewayChannel;
  readonly attachments: { values(): Iterable<DiscordGatewayAttachment> };
  readonly mentions: {
    readonly users: {
      get(id: string): DiscordGatewayUser | undefined;
      has(id: string): boolean;
    };
    readonly roles: {
      get(id: string): { readonly id: string; readonly name: string } | undefined;
    };
    readonly members?: { get(id: string): { readonly displayName: string } | undefined } | null;
  };
  readonly reference?: { readonly messageId?: string; readonly channelId?: string } | null;
  fetchReference(): Promise<DiscordGatewayMessage>;
}

/** Reads the domain message and its attachments from a gateway message. */
export interface DiscordGatewayMessageReader {
  hasSupportedImageAttachment(message: DiscordGatewayMessage): boolean;
  toDiscordMessage(message: DiscordGatewayMessage): DiscordMessage;
  fetchImages(message: DiscordGatewayMessage): Promise<DiscordImageAttachment[]>;
  fetchReplyReference(message: DiscordGatewayMessage): Promise<DiscordReplyReference | undefined>;
}
