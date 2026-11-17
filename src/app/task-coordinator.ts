export type Task = () => Promise<void>;

export class TaskCoordinator {
  private readonly tasks = new Set<Promise<void>>();

  async run(task: Task): Promise<void> {
    const execution = Promise.resolve().then(task);
    this.tasks.add(execution);
    try {
      await execution;
    } finally {
      this.tasks.delete(execution);
    }
  }

  async waitForCompletion(): Promise<void> {
    await Promise.allSettled(this.tasks);
  }
}
