import type { WatchTask } from "../domain/scheduled-task";
import type {
  WatchCheckResult,
  WatchCheckRunner,
  WatchCommandRunner,
  WatchScriptRunner,
} from "./watch-check-runner";

/** Sends each watch to the runner that matches its runtime. */
export class WatchCheckRunnerRouter implements WatchCheckRunner {
  constructor(
    private readonly commandRunner: WatchCommandRunner,
    private readonly scriptRunner: WatchScriptRunner,
  ) {}

  run(watch: WatchTask): Promise<WatchCheckResult> {
    return watch.runtime === "javascript"
      ? this.scriptRunner.run(watch)
      : this.commandRunner.run(watch);
  }
}
