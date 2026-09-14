import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexDelegationService, type CodexTaskScheduler } from "./codex-delegation-service.js";

class InlineTaskScheduler implements CodexTaskScheduler {
  run(task: () => Promise<void>): Promise<void> {
    return Promise.resolve().then(task);
  }
}

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1_000;
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("condition was not met in time"));
        return;
      }
      setTimeout(check, 0);
    };
    check();
  });
}

test("lists projects and completes delegation in the background", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klein-codex-projects-"));
  const defaultWorkspace = join(directory, "klein");
  const otherWorkspace = join(directory, "other-project");
  await Promise.all([mkdir(defaultWorkspace), mkdir(otherWorkspace)]);

  let resolveRun!: (value: {
    threadId: string;
    turnId: string;
    status: "completed";
    summary: string;
  }) => void;
  const runResult = new Promise<{
    threadId: string;
    turnId: string;
    status: "completed";
    summary: string;
  }>((resolve) => {
    resolveRun = resolve;
  });
  const sentMessages: string[] = [];
  const clientWorkspaces: string[] = [];
  const service = new CodexDelegationService({
    channelId: "channel-123",
    createClient: (options) => ({
      run: async () => {
        clientWorkspaces.push(options.cwd);
        return runResult;
      },
    }),
    defaultWorkspace,
    discordService: {
      async sendMessage(_channelId, content) {
        sentMessages.push(content);
      },
    },
    projectsRoot: directory,
    socketPath: join(directory, "server.sock"),
    taskScheduler: new InlineTaskScheduler(),
  });

  try {
    const projects = await service.listProjects();
    assert.deepEqual(
      projects.map(({ id }) => id),
      ["klein", "other-project"],
    );

    const task = await service.submit("修正してテストして", "other-project");
    assert.match(task.id, /^codex-/);
    await waitFor(() => service.getStatus(task.id)?.status === "running");
    assert.deepEqual(clientWorkspaces, [otherWorkspace]);
    assert.match(sentMessages[0] ?? "", /バックグラウンド作業を依頼しました/);

    resolveRun({
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      summary: "変更しました",
    });
    await waitFor(() => service.getStatus(task.id)?.status === "completed");

    const status = service.getStatus(task.id);
    assert.equal(status?.result?.summary, "変更しました");
    assert.match(sentMessages[1] ?? "", /Codex の作業が完了しました/);
    assert.match(sentMessages[1] ?? "", /変更しました/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
