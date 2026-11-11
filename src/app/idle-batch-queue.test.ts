import assert from "node:assert/strict";
import test from "node:test";

import { IdleBatchQueue, type IdleBatchQueueOptions } from "./idle-batch-queue";
import { TaskCoordinator } from "./task-coordinator";

interface Item {
  readonly key: string;
  readonly id: string;
}

function createQueue(
  run: IdleBatchQueueOptions<string, Item>["run"],
  overrides: Partial<Omit<IdleBatchQueueOptions<string, Item>, "run">> = {},
): { queue: IdleBatchQueue<string, Item>; taskCoordinator: TaskCoordinator } {
  const taskCoordinator = new TaskCoordinator();
  const queue = new IdleBatchQueue<string, Item>({
    idleSeconds: 0.01,
    keyOf: (item) => item.key,
    maxBatchAgeSeconds: 1,
    maxBatchMessages: 10,
    onError: () => undefined,
    run,
    taskCoordinator,
    ...overrides,
  });
  return { queue, taskCoordinator };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("batches items per key and flushes them after idle", async () => {
  const processed: { key: string; ids: string[] }[] = [];
  const { queue, taskCoordinator } = createQueue(async (key, items) => {
    processed.push({ key, ids: items.map((item) => item.id) });
  });

  try {
    queue.enqueue({ key: "a", id: "a1" });
    queue.enqueue({ key: "a", id: "a2" });
    queue.enqueue({ key: "b", id: "b1" });

    await delay(30);
    await taskCoordinator.waitForCompletion();

    assert.deepEqual(
      processed.toSorted((left, right) => left.key.localeCompare(right.key)),
      [
        { key: "a", ids: ["a1", "a2"] },
        { key: "b", ids: ["b1"] },
      ],
    );
  } finally {
    queue.dispose();
  }
});

test("flushes immediately when the batch reaches the maximum size", async () => {
  const processed: string[][] = [];
  const { queue, taskCoordinator } = createQueue(
    async (_key, items) => {
      processed.push(items.map((item) => item.id));
    },
    { maxBatchMessages: 2 },
  );

  try {
    queue.enqueue({ key: "a", id: "a1" });
    queue.enqueue({ key: "a", id: "a2" });

    await taskCoordinator.waitForCompletion();
    assert.deepEqual(processed, [["a1", "a2"]]);
  } finally {
    queue.dispose();
  }
});

test("flushes a batch when its oldest item reaches the maximum age", async () => {
  const processed: string[][] = [];
  const { queue, taskCoordinator } = createQueue(
    async (_key, items) => {
      processed.push(items.map((item) => item.id));
    },
    { idleSeconds: 10, maxBatchAgeSeconds: 0.02 },
  );

  try {
    queue.enqueue({ key: "a", id: "a1" });
    await delay(10);
    queue.enqueue({ key: "a", id: "a2" });

    await delay(40);
    await taskCoordinator.waitForCompletion();
    assert.deepEqual(processed, [["a1", "a2"]]);
  } finally {
    queue.dispose();
  }
});

test("puts a failed batch back and retries it", async () => {
  let attempts = 0;
  const processed: string[][] = [];
  const { queue, taskCoordinator } = createQueue(async (_key, items) => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary failure");
    processed.push(items.map((item) => item.id));
  });

  try {
    queue.enqueue({ key: "a", id: "a1" });

    await delay(40);
    await taskCoordinator.waitForCompletion();
    assert.equal(attempts, 2);
    assert.deepEqual(processed, [["a1"]]);
  } finally {
    queue.dispose();
  }
});

test("does not process the same key concurrently", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const processed: string[][] = [];
  let running = 0;
  let maxRunning = 0;
  const { queue, taskCoordinator } = createQueue(async (_key, items) => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    if (items[0]?.id === "a1") await gate;
    processed.push(items.map((item) => item.id));
    running -= 1;
  });

  try {
    queue.enqueue({ key: "a", id: "a1" });
    await delay(20);
    queue.enqueue({ key: "a", id: "a2" });
    await delay(20);

    assert.deepEqual(processed, []);
    release();
    await delay(20);
    await taskCoordinator.waitForCompletion();

    assert.equal(maxRunning, 1);
    assert.deepEqual(processed, [["a1"], ["a2"]]);
  } finally {
    queue.dispose();
  }
});

test("flushes pending items when asked", async () => {
  const processed: string[][] = [];
  const { queue } = createQueue(
    async (_key, items) => {
      processed.push(items.map((item) => item.id));
    },
    { idleSeconds: 60, maxBatchAgeSeconds: 60 },
  );

  try {
    queue.enqueue({ key: "a", id: "a1" });
    await queue.flush();
    assert.deepEqual(processed, [["a1"]]);
  } finally {
    queue.dispose();
  }
});

test("does not retry a failed batch during flush", async () => {
  let attempts = 0;
  const { queue } = createQueue(
    async () => {
      attempts += 1;
      throw new Error("temporary failure");
    },
    { idleSeconds: 60, maxBatchAgeSeconds: 60 },
  );

  try {
    queue.enqueue({ key: "a", id: "a1" });
    await queue.flush();
    assert.equal(attempts, 1);
  } finally {
    queue.dispose();
  }
});

test("drops pending items when disposed", async () => {
  const processed: string[][] = [];
  const { queue, taskCoordinator } = createQueue(async (_key, items) => {
    processed.push(items.map((item) => item.id));
  });

  queue.enqueue({ key: "a", id: "a1" });
  queue.dispose();

  await delay(30);
  await taskCoordinator.waitForCompletion();
  assert.deepEqual(processed, []);
});

test("ignores items whose key is undefined", async () => {
  const processed: string[][] = [];
  const taskCoordinator = new TaskCoordinator();
  const queue = new IdleBatchQueue<string, { key?: string; id: string }>({
    idleSeconds: 0.01,
    keyOf: (item) => item.key,
    maxBatchAgeSeconds: 1,
    maxBatchMessages: 10,
    onError: () => undefined,
    run: async (_key, items) => {
      processed.push(items.map((item) => item.id));
    },
    taskCoordinator,
  });

  try {
    queue.enqueue({ id: "a1" });
    await delay(30);
    await taskCoordinator.waitForCompletion();
    assert.deepEqual(processed, []);
  } finally {
    queue.dispose();
  }
});
