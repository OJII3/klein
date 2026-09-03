export type Task = () => Promise<void>;

export class TaskCoordinator {
  private readonly tasks = new Set<Promise<void>>();

  run(task: Task): Promise<void> {
    const execution = Promise.resolve().then(task);
    this.tasks.add(execution);
    execution.then(
      () => this.tasks.delete(execution),
      () => this.tasks.delete(execution),
    );
    return execution;
  }

  async waitForCompletion(): Promise<void> {
    await Promise.allSettled(this.tasks);
  }
}
