import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexAppServerRunResult,
} from "../infrastructure/codex-app-server-client.js";
import { CodexProjectCatalog, type CodexProject } from "../infrastructure/codex-project-catalog.js";
import type { DiscordService } from "../../discord/ports/discord-service.js";

export interface CodexTaskScheduler {
  run(task: () => Promise<void>): Promise<void>;
}

export type CodexTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface CodexTask {
  readonly id: string;
  readonly project: CodexProject;
  readonly status: CodexTaskStatus;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly result?: CodexAppServerRunResult;
  readonly error?: string;
}

interface MutableCodexTask {
  readonly id: string;
  readonly project: CodexProject;
  readonly createdAt: number;
  status: CodexTaskStatus;
  startedAt?: number;
  completedAt?: number;
  result?: CodexAppServerRunResult;
  error?: string;
}

export interface CodexDelegationServiceOptions {
  readonly socketPath: string;
  readonly defaultWorkspace: string;
  readonly codexHome?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly channelId: string;
  readonly discordService: Pick<DiscordService, "sendMessage">;
  readonly taskScheduler: CodexTaskScheduler;
  readonly logger?: Logger;
  readonly createClient?: (
    options: CodexAppServerClientOptions,
  ) => Pick<CodexAppServerClient, "run">;
}

export class CodexDelegationService {
  private readonly catalog: CodexProjectCatalog;
  private readonly tasks = new Map<string, MutableCodexTask>();
  private readonly createClient: NonNullable<CodexDelegationServiceOptions["createClient"]>;

  constructor(private readonly options: CodexDelegationServiceOptions) {
    this.catalog = new CodexProjectCatalog({
      defaultWorkspace: options.defaultWorkspace,
      codexHome: options.codexHome,
    });
    this.createClient =
      options.createClient ?? ((clientOptions) => new CodexAppServerClient(clientOptions));
  }

  listProjects(): Promise<readonly CodexProject[]> {
    return this.catalog.list();
  }

  async submit(task: string, project?: string): Promise<CodexTask> {
    const selectedProject = await this.catalog.resolve(project);
    const record: MutableCodexTask = {
      id: `codex-${randomUUID()}`,
      project: selectedProject,
      status: "queued",
      createdAt: Date.now(),
    };
    this.tasks.set(record.id, record);

    await this.notifyAccepted(record);

    const execution = this.options.taskScheduler.run(async () => {
      record.status = "running";
      record.startedAt = Date.now();

      try {
        const result = await this.createClient({
          cwd: selectedProject.path,
          model: this.options.model,
          socketPath: this.options.socketPath,
          timeoutMs: this.options.timeoutMs,
        }).run(task);
        record.status = "completed";
        record.result = result;
      } catch (error) {
        record.status = classifyFailure(error);
        record.error = errorMessage(error);
      } finally {
        record.completedAt = Date.now();
        await this.notify(record);
      }
    });
    void execution.catch((error: unknown) => {
      this.options.logger?.error(
        { err: error, event: "codex_delegation_task_failed", taskId: record.id },
        "Codex delegation task runner failed",
      );
    });

    return this.snapshot(record);
  }

  getStatus(taskId: string): CodexTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? this.snapshot(task) : undefined;
  }

  private async notify(task: MutableCodexTask): Promise<void> {
    const message =
      task.status === "completed"
        ? `✅ Codex の作業が完了しました\n` +
          `task: ${task.id}\n` +
          `project: ${task.project.name}\n\n` +
          `${task.result?.summary ?? "完了しました。"}`
        : `❌ Codex の作業が終了しました\n` +
          `task: ${task.id}\n` +
          `project: ${task.project.name}\n` +
          `status: ${task.status}\n\n` +
          `${task.error ?? "原因不明のエラーです。"}`;

    try {
      await this.options.discordService.sendMessage(this.options.channelId, message);
    } catch (error) {
      this.options.logger?.error(
        { err: error, event: "codex_delegation_notification_failed", taskId: task.id },
        "Failed to notify Discord about Codex delegation",
      );
    }
  }

  private async notifyAccepted(task: MutableCodexTask): Promise<void> {
    try {
      await this.options.discordService.sendMessage(
        this.options.channelId,
        `🛠️ Codex にバックグラウンド作業を依頼しました\n` +
          `task: ${task.id}\n` +
          `project: ${task.project.name}\n` +
          "完了または失敗したら、このチャンネルに通知します。",
      );
    } catch (error) {
      this.options.logger?.error(
        { err: error, event: "codex_delegation_acceptance_notification_failed", taskId: task.id },
        "Failed to notify Discord about accepted Codex delegation",
      );
    }
  }

  private snapshot(task: MutableCodexTask): CodexTask {
    return {
      ...task,
      project: { ...task.project },
    };
  }
}

function classifyFailure(
  error: unknown,
): Exclude<CodexTaskStatus, "queued" | "running" | "completed"> {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("timed out")) return "timed_out";
  if (message.includes("cancelled")) return "cancelled";
  return "failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
