export interface ShutdownRunnerOptions {
  readonly timeoutMs: number;
  readonly shutdown: (signal: string) => Promise<void>;
  readonly onTimeout: (signal: string) => void;
  readonly onError: (error: unknown, signal: string) => void;
  readonly exit: (code: number) => void;
}

/**
 * Runs the shutdown sequence once and then exits the process explicitly.
 *
 * Waiting for the event loop to drain is not enough: Bun keeps the process alive
 * for handles that the shutdown path does not own, so a stopped bot can hang
 * after it has already flushed and closed everything it manages. The watchdog
 * bounds the cleanup itself, so a stuck close cannot block termination either.
 */
export function createShutdownRunner(
  options: ShutdownRunnerOptions,
): (signal: string, exitCode?: number) => Promise<void> {
  let running: Promise<void> | undefined;
  return (signal: string, exitCode = 0): Promise<void> => {
    running ??= (async () => {
      const watchdog = setTimeout(() => {
        options.onTimeout(signal);
        options.exit(1);
      }, options.timeoutMs);
      watchdog.unref?.();

      let code = exitCode;
      try {
        await options.shutdown(signal);
      } catch (error) {
        code = 1;
        options.onError(error, signal);
      } finally {
        clearTimeout(watchdog);
      }
      options.exit(code);
    })();
    return running;
  };
}
