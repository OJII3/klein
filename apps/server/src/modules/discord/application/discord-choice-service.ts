import { randomUUID } from "node:crypto";

import type { DiscordAccessPolicy } from "../domain/discord-access-policy";
import {
  createDiscordChoiceAnswerMessage,
  createDiscordChoiceButtonId,
  parseDiscordChoiceButtonId,
  type DiscordChoiceButton,
  type DiscordChoiceRequest,
  type PendingDiscordChoice,
} from "../domain/discord-choice";
import type { DiscordMessage } from "../domain/discord-message";

const MAX_PENDING_CHOICES = 100;

export type DiscordChoiceRejection =
  "expired" | "not-requester" | "channel-denied" | "invalid-option";

export interface DiscordChoiceQuestionView {
  readonly channelId: string;
  readonly question: string;
  readonly options: readonly string[];
  /** Custom ids for the buttons, in the same order as {@link options}. */
  readonly buttonIds: readonly string[];
}

export interface DiscordChoiceAnsweredView {
  readonly question: string;
  readonly label: string;
  readonly userId: string;
}

export type DiscordChoiceButtonResult =
  | { readonly kind: "ignored" }
  | { readonly kind: "rejected"; readonly reason: DiscordChoiceRejection }
  | {
      readonly kind: "answered";
      readonly view: DiscordChoiceAnsweredView;
      readonly answer: DiscordMessage;
    };

/**
 * Keeps the pending questions and decides whether a pressed button is a valid
 * answer. Rendering the question and the answer stays with the caller.
 */
export class DiscordChoiceService {
  private readonly pending = new Map<string, PendingDiscordChoice>();

  constructor(private readonly accessPolicy: Pick<DiscordAccessPolicy, "canReceive">) {}

  async send(
    channelId: string,
    request: DiscordChoiceRequest,
    postQuestion: (view: DiscordChoiceQuestionView) => Promise<{ messageId: string }>,
  ): Promise<string> {
    const nonce = randomUUID();
    const view: DiscordChoiceQuestionView = {
      channelId,
      question: request.question,
      options: request.options,
      buttonIds: request.options.map((_, index) => createDiscordChoiceButtonId(nonce, index)),
    };

    const { messageId } = await postQuestion(view);
    this.remember({ ...request, nonce, channelId, messageId });
    return messageId;
  }

  handleButton(button: DiscordChoiceButton): DiscordChoiceButtonResult {
    const parsed = parseDiscordChoiceButtonId(button.customId);
    if (!parsed) return { kind: "ignored" };

    const pending = this.pending.get(parsed.nonce);
    if (!pending) return { kind: "rejected", reason: "expired" };

    if (button.user.id !== pending.requesterUserId) {
      return { kind: "rejected", reason: "not-requester" };
    }

    if (!this.canAnswer(button)) {
      return { kind: "rejected", reason: "channel-denied" };
    }

    const label = pending.options[parsed.index];
    if (label === undefined) {
      return { kind: "rejected", reason: "invalid-option" };
    }

    this.pending.delete(parsed.nonce);
    return {
      kind: "answered",
      view: { question: pending.question, label, userId: button.user.id },
      answer: createDiscordChoiceAnswerMessage(button, pending, label),
    };
  }

  clear(): void {
    this.pending.clear();
  }

  private remember(pending: PendingDiscordChoice): void {
    this.pending.set(pending.nonce, pending);
    while (this.pending.size > MAX_PENDING_CHOICES) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) return;
      this.pending.delete(oldest);
    }
  }

  private canAnswer(button: DiscordChoiceButton): boolean {
    const channel = button.channel;
    const thread = channel?.isThread ? channel : undefined;
    return this.accessPolicy.canReceive({
      guildId: button.guildId,
      channelId: thread?.parentId ?? button.channelId,
      threadId: thread?.id,
      userId: button.user.id,
      userIsBot: button.user.bot,
    });
  }
}
