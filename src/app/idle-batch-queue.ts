import type { TaskCoordinator } from "./task-coordinator";

export interface IdleBatchFailure<TKey, TItem> {
  readonly key: TKey;
  readonly batch: readonly TItem[];
  readonly error: unknown;
  readonly durationMs: number;
}

export interface IdleBatchQueueOptions<TKey, TItem> {
  readonly idleSeconds: number;
  readonly maxBatchAgeSeconds: number;
  readonly maxBatchMessages: number;
  readonly taskCoordinator: TaskCoordinator;
  readonly keyOf: (item: TItem) => TKey | undefined;
  readonly run: (key: TKey, batch: readonly TItem[]) => Promise<void>;
  readonly onError: (failure: IdleBatchFailure<TKey, TItem>) => void;
}

interface Batch<TItem> {
  readonly items: TItem[];
  processing: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  maxAgeTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Batches items per key and runs one batch after the key goes idle. A batch is also
 * flushed when it reaches the maximum size or its oldest item reaches the maximum age.
 * Failed batches are put back at the front of the queue and retried after the same
 * idle or maximum-age delay.
 */
export class IdleBatchQueue<TKey, TItem> {
  private readonly batches = new Map<TKey, Batch<TItem>>();
  private disposed = false;
  private flushing = false;

  constructor(private readonly options: IdleBatchQueueOptions<TKey, TItem>) {}

  enqueue(item: TItem): void {
    if (this.disposed) return;

    const key = this.options.keyOf(item);
    if (key === undefined) return;

    let batch = this.batches.get(key);
    if (!batch) {
      batch = { items: [], processing: false };
      this.batches.set(key, batch);
    }

    batch.items.push(item);
    if (batch.items.length >= this.options.maxBatchMessages) {
      this.scheduleProcessing(key);
      return;
    }

    this.resetIdleTimer(key, batch);
    if (!batch.maxAgeTimer) {
      batch.maxAgeTimer = setTimeout(
        () => this.scheduleProcessing(key),
        this.options.maxBatchAgeSeconds * 1_000,
      );
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const batch of this.batches.values()) {
      if (batch.idleTimer) clearTimeout(batch.idleTimer);
      if (batch.maxAgeTimer) clearTimeout(batch.maxAgeTimer);
    }
    this.batches.clear();
  }

  /**
   * Processes every pending batch now and waits for the work to finish. A batch that
   * fails during the flush is not put back, so shutdown does not wait for a retry.
   */
  async flush(): Promise<void> {
    if (this.disposed) return;

    this.flushing = true;
    try {
      for (;;) {
        const pendingKeys = [...this.batches.entries()]
          .filter(([, batch]) => batch.items.length > 0 && !batch.processing)
          .map(([key]) => key);

        if (pendingKeys.length === 0) {
          await this.options.taskCoordinator.waitForCompletion();
          const stillPending = [...this.batches.values()].some(
            (batch) => batch.items.length > 0 || batch.processing,
          );
          if (!stillPending) return;
          continue;
        }

        for (const key of pendingKeys) this.scheduleProcessing(key);
        await this.options.taskCoordinator.waitForCompletion();
      }
    } finally {
      this.flushing = false;
    }
  }

  private scheduleProcessing(key: TKey): void {
    const batch = this.batches.get(key);
    if (!batch || this.disposed) return;

    if (batch.idleTimer) {
      clearTimeout(batch.idleTimer);
      batch.idleTimer = undefined;
    }
    if (batch.maxAgeTimer) {
      clearTimeout(batch.maxAgeTimer);
      batch.maxAgeTimer = undefined;
    }

    void this.options.taskCoordinator.run(() => this.process(key));
  }

  private async process(key: TKey): Promise<void> {
    const batch = this.batches.get(key);
    if (!batch || batch.processing || batch.items.length === 0) return;

    batch.processing = true;
    const items = batch.items.splice(0, this.options.maxBatchMessages);
    const startedAt = Date.now();
    let failed = false;

    try {
      await this.options.run(key, items);
    } catch (error) {
      failed = true;
      if (!this.flushing) batch.items.unshift(...items);
      this.options.onError({
        batch: items,
        durationMs: Date.now() - startedAt,
        error,
        key,
      });
    } finally {
      batch.processing = false;
      if (this.disposed || batch.items.length === 0) {
        this.batches.delete(key);
      } else if (failed && !this.flushing) {
        this.resetIdleTimer(key, batch);
        batch.maxAgeTimer = setTimeout(
          () => this.scheduleProcessing(key),
          this.options.maxBatchAgeSeconds * 1_000,
        );
      } else {
        this.scheduleProcessing(key);
      }
    }
  }

  private resetIdleTimer(key: TKey, batch: Batch<TItem>): void {
    if (batch.idleTimer) clearTimeout(batch.idleTimer);
    batch.idleTimer = setTimeout(
      () => this.scheduleProcessing(key),
      this.options.idleSeconds * 1_000,
    );
  }
}
