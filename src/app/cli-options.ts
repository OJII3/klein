export type SessionMode = "new" | "resume";

export interface CliOptions {
  readonly sessionMode: SessionMode;
}

export function parseCliOptions(args: readonly string[]): CliOptions {
  let sessionMode: SessionMode | undefined;

  for (const arg of args) {
    const nextMode = arg === "--resume" ? "resume" : arg === "--new" ? "new" : undefined;
    if (!nextMode) {
      throw new Error(`Unknown option: ${arg}. Use --resume or --new.`);
    }

    if (sessionMode && sessionMode !== nextMode) {
      throw new Error("Cannot use --resume and --new together");
    }

    sessionMode = nextMode;
  }

  return { sessionMode: sessionMode ?? "resume" };
}
