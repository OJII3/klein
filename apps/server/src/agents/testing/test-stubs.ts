import {
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  createExtensionRuntime,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

import type { AgentToolContext } from "@agents/core/agent-factory";
import type { DiscordChannelApi } from "@modules/discord/ports/discord-channel-api";
import type {
  ReminderTask,
  ScheduledTask,
  ScheduledTaskAccessScope,
  WatchTask,
} from "@modules/scheduling/domain/scheduled-task";
import type { ScheduledTaskStore } from "@modules/scheduling/ports/scheduled-task-store";
import type { TextToSpeech } from "@modules/tts/ports/text-to-speech";

let cachedExtensionRunnerPromise: Promise<ExtensionRunner> | undefined;

async function getStubExtensionRunner(): Promise<ExtensionRunner> {
  if (!cachedExtensionRunnerPromise) {
    cachedExtensionRunnerPromise = (async () => {
      const modelRuntime = await ModelRuntime.create({
        credentials: {
          async read() {
            return undefined;
          },
          async list() {
            return [];
          },
          async modify() {
            return undefined;
          },
          async delete() {},
        },
        modelsPath: null,
        refreshOnCreate: false,
      });
      return new ExtensionRunner(
        [],
        createExtensionRuntime(),
        process.cwd(),
        SessionManager.inMemory(),
        new ModelRegistry(modelRuntime),
      );
    })();
  }
  return cachedExtensionRunnerPromise;
}

export async function createStubExtensionToolContext(
  toolCallId = "tool-call",
): Promise<ExtensionToolContext> {
  const runner = await getStubExtensionRunner();
  return runner.createToolContext(toolCallId, undefined);
}

export function createStubDiscordChannelApi(
  overrides: Partial<DiscordChannelApi> = {},
): DiscordChannelApi {
  return {
    async getChannelLocation(channelId) {
      return { channelId };
    },
    async sendTyping() {},
    async sendMessage() {},
    async sendChoices() {
      throw new Error("Unexpected sendChoices call in test stub");
    },
    async sendAudio() {},
    async readMessage() {
      throw new Error("Unexpected readMessage call in test stub");
    },
    async readMessages() {
      throw new Error("Unexpected readMessages call in test stub");
    },
    ...overrides,
  };
}

export function createStubTextToSpeech(overrides: Partial<TextToSpeech> = {}): TextToSpeech {
  return {
    async synthesize() {
      return new Uint8Array();
    },
    ...overrides,
  };
}

export function createStubAgentToolContext(
  overrides: Partial<AgentToolContext> = {},
): AgentToolContext {
  return {
    requesterId: () => undefined,
    ...overrides,
  };
}

export interface InMemoryScheduledTaskStoreHooks {
  readonly onListForScope?: (
    kind: ScheduledTask["kind"],
    channelId: string,
    accessScope: ScheduledTaskAccessScope,
  ) => void;
  readonly onDelete?: (
    kind: ScheduledTask["kind"],
    channelId: string,
    accessScope: ScheduledTaskAccessScope,
    taskId: string,
  ) => void;
}

export class InMemoryScheduledTaskStore implements ScheduledTaskStore {
  readonly tasks = new Map<string, ScheduledTask>();
  readonly created: ScheduledTask[] = [];
  readonly deletedIds: string[] = [];

  constructor(
    initial: readonly ScheduledTask[] = [],
    private readonly hooks: InMemoryScheduledTaskStoreHooks = {},
  ) {
    for (const task of initial) {
      this.tasks.set(task.id, task);
    }
  }

  async create(task: ScheduledTask): Promise<void> {
    this.tasks.set(task.id, task);
    this.created.push(task);
  }

  async listDue(now: number): Promise<readonly ScheduledTask[]> {
    return [...this.tasks.values()].filter(
      (task) => (task.kind !== "watch" || task.enabled) && Date.parse(task.nextRunAt) <= now,
    );
  }

  listForScope(
    kind: "reminder",
    channelId: string,
    accessScope: ScheduledTaskAccessScope,
  ): Promise<readonly ReminderTask[]>;
  listForScope(
    kind: "watch",
    channelId: string,
    accessScope: ScheduledTaskAccessScope,
  ): Promise<readonly WatchTask[]>;
  listForScope(
    kind: ScheduledTask["kind"],
    channelId: string,
    accessScope: ScheduledTaskAccessScope,
  ): Promise<readonly ScheduledTask[]>;
  async listForScope(
    kind: ScheduledTask["kind"],
    channelId: string,
    accessScope: ScheduledTaskAccessScope,
  ): Promise<readonly ScheduledTask[]> {
    this.hooks.onListForScope?.(kind, channelId, accessScope);
    return [...this.tasks.values()].filter(
      (task) =>
        task.kind === kind && task.channelId === channelId && task.accessScope === accessScope,
    );
  }

  async delete(
    kind: ScheduledTask["kind"],
    channelId: string,
    accessScope: ScheduledTaskAccessScope,
    taskId: string,
  ): Promise<boolean> {
    this.hooks.onDelete?.(kind, channelId, accessScope, taskId);
    const task = this.tasks.get(taskId);
    if (
      !task ||
      task.kind !== kind ||
      task.channelId !== channelId ||
      task.accessScope !== accessScope
    ) {
      return false;
    }
    this.deletedIds.push(taskId);
    return this.tasks.delete(taskId);
  }

  async update(task: ScheduledTask): Promise<void> {
    this.tasks.set(task.id, task);
  }
}
