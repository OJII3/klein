import type { Logger } from "pino";

import type { DiscordMessage } from "@modules/discord/domain/discord-message";
import type {
  VoiceTranscriptQueueAction,
  VoiceTranscriptQueueSelector,
} from "@modules/discord/ports/voice-transcript-queue-selector";

interface VoiceTranscriptQueueOptions {
  readonly selector: VoiceTranscriptQueueSelector;
  readonly logger: Logger;
  readonly isStopped: () => boolean;
  readonly isProcessing: () => boolean;
  readonly currentTranscript: () => string;
  readonly processNext: () => void;
  readonly steer?: (message: DiscordMessage) => Promise<void>;
}

export class VoiceTranscriptQueue {
  private readonly messages: DiscordMessage[] = [];
  private decisionTimer: ReturnType<typeof setTimeout> | undefined;
  private decisionController: AbortController | undefined;
  private revision = 0;

  constructor(private readonly options: VoiceTranscriptQueueOptions) {}

  get hasPending(): boolean {
    return this.messages.length > 0;
  }

  get length(): number {
    return this.messages.length;
  }

  enqueue(message: DiscordMessage): void {
    this.messages.push(message);
  }

  takeNext(): DiscordMessage | undefined {
    return this.messages.shift();
  }

  scheduleDecision(): void {
    if (this.options.isStopped() || !this.hasPending) return;

    this.revision += 1;
    this.decisionController?.abort();
    this.decisionController = undefined;
    if (this.decisionTimer) clearTimeout(this.decisionTimer);
    const revision = this.revision;
    const controller = new AbortController();
    this.decisionController = controller;
    this.decisionTimer = setTimeout(
      () => {
        this.decisionTimer = undefined;
        void this.decide(revision, controller).finally(() => {
          if (this.decisionController === controller) this.decisionController = undefined;
        });
      },
      this.options.isProcessing() ? 80 : 0,
    );
  }

  stop(): void {
    if (this.decisionTimer) clearTimeout(this.decisionTimer);
    this.decisionController?.abort();
    this.messages.length = 0;
  }

  private async decide(revision: number, controller: AbortController): Promise<void> {
    if (this.options.isStopped() || controller.signal.aborted || this.messages.length === 0) {
      return;
    }
    if (!this.options.isProcessing()) {
      this.options.processNext();
      return;
    }

    let action: VoiceTranscriptQueueAction;
    try {
      action = await this.options.selector.select(
        {
          currentTranscript: this.options.currentTranscript(),
          queuedTranscripts: this.messages.map((message) => message.content),
        },
        controller.signal,
      );
    } catch {
      action = "keep";
    }
    if (controller.signal.aborted || revision !== this.revision || this.options.isStopped()) {
      return;
    }
    await this.apply(action, revision, controller);
  }

  private async apply(
    action: VoiceTranscriptQueueAction,
    revision: number,
    controller: AbortController,
  ): Promise<void> {
    if (this.options.isStopped() || controller.signal.aborted || revision !== this.revision) {
      return;
    }
    if (action === "discard") {
      const discarded = this.messages.shift();
      this.options.logger.info(
        {
          event: "voice_chat_transcript_discarded",
          messageId: discarded?.id,
          queueLength: this.messages.length,
        },
        "Discarded a voice transcript based on the queue classification",
      );
      this.scheduleDecision();
      return;
    }

    if (action === "merge" && this.messages.length > 1) {
      const first = this.messages[0]!;
      const second = this.messages[1]!;
      this.messages.splice(0, 2, {
        ...first,
        content: `${first.content}\n${second.content}`,
      });
      this.options.logger.info(
        {
          event: "voice_chat_transcripts_merged",
          messageId: first.id,
          queueLength: this.messages.length,
        },
        "Merged adjacent voice transcripts based on the queue classification",
      );
      this.scheduleDecision();
      return;
    }

    if (action === "steer" && this.options.steer) {
      const message = this.messages.shift();
      if (message) await this.options.steer(message);
      this.scheduleDecision();
      return;
    }

    if (!this.options.isProcessing()) this.options.processNext();
  }
}
