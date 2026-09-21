import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";

import type { CodingProject, CodingProjectId, CodingProjectState } from "../domain/coding-project";
import type {
  CodingRun,
  CodingRunId,
  CodingRunStatus,
  CodingSessionId,
} from "../domain/coding-run";
import type { StartCodingRunInput, CodingHarness } from "../ports/coding-harness";

type OpenCodeClient = ReturnType<typeof OpenCode.make>;

interface MutableCodingRun {
  id: CodingRunId;
  projectId: CodingProjectId;
  sessionId: CodingSessionId;
  status: CodingRunStatus;
  startedAt: Date;
  updatedAt: Date;
  result?: string;
  error?: string;
  inboxId?: string;
}

export interface OpenCodeCodingHarnessOptions {
  readonly serverUrl?: string;
  readonly projects: Readonly<Record<string, string>>;
  readonly username?: string;
  readonly password?: string;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTerminal(status: CodingRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function runSnapshot(run: MutableCodingRun): CodingRun {
  return {
    id: run.id,
    projectId: run.projectId,
    sessionId: run.sessionId,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    result: run.result,
    error: run.error,
  };
}

export async function createOpenCodeCodingHarness(
  options: OpenCodeCodingHarnessOptions,
): Promise<OpenCodeCodingHarness> {
  let client: OpenCodeClient;
  if (options.serverUrl) {
    const headers = options.password
      ? {
          Authorization: `Basic ${Buffer.from(
            `${options.username ?? "opencode"}:${options.password}`,
          ).toString("base64")}`,
        }
      : undefined;
    client = OpenCode.make({ baseUrl: options.serverUrl, headers });
  } else {
    const endpoint = await Service.discover();
    if (!endpoint) {
      throw new Error(
        "No compatible local OpenCode service found; configure features.coding.serverUrl to connect directly",
      );
    }
    client = OpenCode.make({
      baseUrl: endpoint.url,
      headers: Service.headers(endpoint),
    });
  }

  return new OpenCodeCodingHarness(client, options.projects);
}

export class OpenCodeCodingHarness implements CodingHarness {
  private readonly projects = new Map<CodingProjectId, string>();
  private readonly runs = new Map<CodingRunId, MutableCodingRun>();
  private readonly startingSessions = new Set<CodingSessionId>();

  constructor(
    private readonly client: OpenCodeClient,
    projects: Readonly<Record<string, string>>,
  ) {
    for (const [projectId, directory] of Object.entries(projects)) {
      if (!isAbsolute(directory)) {
        throw new Error(`Coding project directory must be absolute: ${projectId}`);
      }

      this.projects.set(projectId as CodingProjectId, resolve(directory));
    }

    if (this.projects.size === 0) {
      throw new Error("At least one coding project must be configured when coding is enabled");
    }
  }

  async checkConnection(): Promise<void> {
    await this.client.server.info();
  }

  async listProjects(): Promise<readonly CodingProject[]> {
    return [...this.projects.keys()].map((id) => ({ id }));
  }

  async getProjectState(projectId: CodingProjectId): Promise<CodingProjectState> {
    const project = this.project(projectId);
    const activeRuns = [...this.runs.values()]
      .filter((run) => run.projectId === projectId && !isTerminal(run.status))
      .map(runSnapshot);

    return { project, activeRuns };
  }

  async startRun(input: StartCodingRunInput): Promise<CodingRun> {
    const directory = this.directory(input.projectId);
    const session = input.sessionId
      ? await this.sessionForProject(input.sessionId, directory)
      : await this.client.session.create({ location: { directory } });

    if (
      this.startingSessions.has(session.id) ||
      [...this.runs.values()].some((run) => run.sessionId === session.id && !isTerminal(run.status))
    ) {
      throw new Error("This OpenCode session already has an active Klein coding run");
    }

    const now = new Date();
    const run: MutableCodingRun = {
      id: randomUUID(),
      projectId: input.projectId,
      sessionId: session.id,
      status: "queued",
      startedAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    this.startingSessions.add(session.id);

    try {
      const active = await this.client.session.active();
      const inbox = await this.client.session.prompt({
        sessionID: session.id,
        text: input.prompt,
        delivery: "queue",
      });
      run.inboxId = inbox.id;
      run.status = active[session.id] ? "waiting" : "running";
      run.updatedAt = new Date();
      void this.monitorRun(run);
    } catch (error) {
      run.status = "failed";
      run.error = toErrorMessage(error);
      run.updatedAt = new Date();
    } finally {
      this.startingSessions.delete(session.id);
    }

    return runSnapshot(run);
  }

  async getRun(runId: CodingRunId): Promise<CodingRun> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Coding run not found: ${runId}`);
    return runSnapshot(run);
  }

  async cancelRun(runId: CodingRunId): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Coding run not found: ${runId}`);
    if (isTerminal(run.status)) return;

    if (run.status === "waiting" && run.inboxId) {
      await this.client.session.inbox.cancel({
        sessionID: run.sessionId,
        inboxID: run.inboxId,
      });
    } else {
      await this.client.session.interrupt({ sessionID: run.sessionId });
    }

    if (!isTerminal(run.status)) {
      run.status = "cancelled";
      run.updatedAt = new Date();
    }
  }

  private async monitorRun(run: MutableCodingRun): Promise<void> {
    try {
      await this.client.session.wait({ sessionID: run.sessionId });
      const [session, messages] = await Promise.all([
        this.client.session.get({ sessionID: run.sessionId }),
        this.client.session.context({ sessionID: run.sessionId }),
      ]);
      if (isTerminal(run.status)) return;

      if (session.outcome === "failed") {
        const assistantMessage = [...messages]
          .reverse()
          .find((message) => message.type === "assistant");
        run.status = "failed";
        run.error =
          assistantMessage?.type === "assistant"
            ? (assistantMessage.error?.message ?? "OpenCode run failed")
            : "OpenCode run failed";
      } else if (session.outcome === "interrupted") {
        run.status = "cancelled";
      } else {
        const assistantMessage = [...messages]
          .reverse()
          .find((message) => message.type === "assistant");
        run.status = "completed";
        run.result =
          assistantMessage?.type === "assistant"
            ? assistantMessage.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n")
            : "";
      }
      run.updatedAt = new Date();
    } catch (error) {
      if (!isTerminal(run.status)) {
        run.status = "failed";
        run.error = toErrorMessage(error);
        run.updatedAt = new Date();
      }
    }
  }

  private async sessionForProject(sessionId: string, directory: string) {
    const session = await this.client.session.get({ sessionID: sessionId });
    if (resolve(session.location.directory) !== directory) {
      throw new Error("OpenCode session does not belong to the selected coding project");
    }
    return session;
  }

  private project(projectId: CodingProjectId): CodingProject {
    this.directory(projectId);
    return { id: projectId };
  }

  private directory(projectId: CodingProjectId): string {
    const directory = this.projects.get(projectId);
    if (!directory) throw new Error(`Coding project is not configured: ${projectId}`);
    return directory;
  }
}
