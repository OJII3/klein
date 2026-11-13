import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  parseSessionEntries,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

import { loadConfig } from "../src/app/config";
import {
  extractSessionTurns,
  extractTurnTraceFromEntries,
  formatContextInspectionMarkdown,
  formatReplayResultMarkdown,
  inspectFeedbackCase,
  inspectSessionEntries,
  replayFeedbackCase,
  replaySessionEntries,
  type SessionReplayMode,
} from "../src/runtime/pi/context-inspector";
import { SessionEvalCaseStore } from "../src/runtime/pi/session-eval-store";

type Subcommand = "cases" | "sessions" | "show" | "replay";
type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

interface CliOptions {
  readonly command: Subcommand;
  readonly profile: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly defaultProvider: string;
  readonly defaultModel: string;
  readonly defaultThinkingLevel?: ThinkingLevel;
  readonly agentDir: string;
  readonly sessionsDir: string;
  readonly caseRef?: string;
  readonly session?: string;
  readonly turn?: number;
  readonly mode?: SessionReplayMode;
  readonly limit?: number;
  readonly includeTools: boolean;
  readonly includeRawPayload: boolean;
  readonly json: boolean;
  readonly outPath?: string;
}

interface DiscoveredSessionFile {
  readonly filePath: string;
  readonly sessionKey: string;
  readonly mtimeMs: number;
  readonly mtimeIso: string;
}

async function parseOptions(argv: readonly string[]): Promise<CliOptions> {
  let configProfile = "klein";
  let configProvider = "opencode-go";
  let configModel = "deepseek-v4.1-flash";
  let configThinkingLevel: ThinkingLevel | undefined;
  let configAgentDir = ".runtime/pi";

  try {
    const config = await loadConfig();
    configProfile = config.profile;
    configProvider = config.llm.provider;
    configModel = config.llm.model;
    configThinkingLevel = config.llm.thinkingLevel;
    configAgentDir = config.runtime.agentDir;
  } catch {
    // Fall back to defaults when config/config.jsonc is absent.
  }

  const args = [...argv];
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    process.exit(0);
  }

  const rawCommand = args.shift()!;
  if (
    rawCommand !== "cases" &&
    rawCommand !== "sessions" &&
    rawCommand !== "show" &&
    rawCommand !== "replay"
  ) {
    throw new Error(
      `Unknown command: ${rawCommand} (expected one of: cases, sessions, show, replay)`,
    );
  }

  let profile = configProfile;
  let provider: string | undefined;
  let model: string | undefined;
  let thinkingLevel: ThinkingLevel | undefined;
  let agentDir = configAgentDir;
  let sessionsDir: string | undefined;
  let caseRef: string | undefined;
  let session: string | undefined;
  let turn: number | undefined;
  let mode: SessionReplayMode | undefined;
  let limit: number | undefined;
  let includeTools = rawCommand === "show";
  let includeRawPayload = false;
  let json = false;
  let outPath: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--profile" && args[i + 1]) {
      profile = args[++i]!;
    } else if (arg === "--provider" && args[i + 1]) {
      provider = args[++i]!;
    } else if (arg === "--model" && args[i + 1]) {
      model = args[++i]!;
    } else if (arg === "--thinking" && args[i + 1]) {
      thinkingLevel = args[++i]! as ThinkingLevel;
    } else if (arg === "--agent-dir" && args[i + 1]) {
      agentDir = args[++i]!;
    } else if (arg === "--sessions-dir" && args[i + 1]) {
      sessionsDir = args[++i]!;
    } else if (arg === "--case" && args[i + 1]) {
      caseRef = args[++i]!;
    } else if (arg === "--session" && args[i + 1]) {
      session = args[++i]!;
    } else if (arg === "--turn" && args[i + 1]) {
      turn = parseIntOption(args[++i]!, "--turn");
    } else if (arg === "--mode" && args[i + 1]) {
      const value = args[++i]!;
      if (value !== "turn-start" && value !== "pre-message") {
        throw new Error(`Invalid --mode value: ${value} (expected turn-start or pre-message)`);
      }
      mode = value;
    } else if (arg === "--limit" && args[i + 1]) {
      limit = parseIntOption(args[++i]!, "--limit");
    } else if (arg === "--no-tools") {
      includeTools = false;
    } else if (arg === "--tools") {
      includeTools = true;
    } else if (arg === "--raw-payload") {
      includeRawPayload = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--out" && args[i + 1]) {
      outPath = args[++i]!;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
  }

  const resolvedAgentDir = resolve(agentDir);
  return {
    command: rawCommand,
    profile,
    provider,
    model,
    thinkingLevel,
    defaultProvider: configProvider,
    defaultModel: configModel,
    defaultThinkingLevel: configThinkingLevel,
    agentDir: resolvedAgentDir,
    sessionsDir: resolve(sessionsDir ?? join(resolvedAgentDir, "sessions")),
    caseRef,
    session,
    turn,
    mode,
    limit,
    includeTools,
    includeRawPayload,
    json,
    outPath,
  };
}

function parseIntOption(raw: string, flagName: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer for ${flagName}: ${raw}`);
  }
  return parsed;
}

function printUsage(): void {
  console.log(
    [
      "Usage: bun scripts/inspect-context.ts <command> [options]",
      "",
      "Commands:",
      "  cases       List recorded negative-feedback (👎) candidate cases",
      "  sessions    List recent saved Pi session files",
      "  show        Inspect recorded turn trace and raw context sent to the LLM (offline, no API call)",
      "  replay      Re-run a case or session turn against the live configured LLM API (discord_send is captured)",
      "",
      "Common Options:",
      "  --agent-dir <dir>        Agent runtime directory (default: config.runtime.agentDir or .runtime/pi)",
      "  --sessions-dir <dir>     Pi sessions root directory (default: <agent-dir>/sessions)",
      "  --profile <name>         Profile name under config/ (default: config.jsonc or klein)",
      "  --provider <id>          Provider ID override",
      "  --model <id>             Model ID override",
      "  --thinking <level>       Thinking level override (off|minimal|low|medium|high|xhigh)",
      "  --json                   Output structured JSON",
      "  --out <path>             Write output to file in addition to printing",
      "",
      "Target Options (for show / replay):",
      "  --case <id|path>         Target a saved feedback case (caseId, messageId, or .case.json path)",
      "  --session <path|id>      Target a saved Pi session (.jsonl path, session ID, or substring)",
      "  --turn <index>           Turn index for --session (0-based or negative like -1; default: -1)",
      "  --mode <mode>            turn-start (current SOUL/tools) or pre-message (up to right before discord_send)",
      "  --raw-payload            Include raw provider HTTP JSON payload",
      "  --no-tools / --tools     Toggle declared tool schemas in markdown output",
      "",
      "List Options (for cases / sessions):",
      "  --limit <N>              Maximum number of items to list (default: 20)",
    ].join("\n"),
  );
}

async function runCasesCommand(options: CliOptions): Promise<void> {
  const store = new SessionEvalCaseStore({ agentDir: options.agentDir });
  const allCases = await store.listCases();
  const limit = options.limit ?? 20;
  const listed = allCases.slice(0, limit);

  const enriched = await Promise.all(
    listed.map(async (item) => {
      let userPreview = "";
      try {
        const loaded = await store.loadCase(item.caseId);
        if (loaded) {
          const trace = extractTurnTraceFromEntries(loaded.entries, {
            targetAssistantEntryId: item.slice.targetAssistantEntryId,
          });
          if (trace?.userText) {
            userPreview = toPreview(extractEventBody(trace.userText), 100);
          }
        }
      } catch {
        // Ignore preview extraction failure.
      }
      return {
        caseId: item.caseId,
        occurredAt: item.reaction.occurredAt,
        emoji: item.reaction.emoji,
        userId: item.reaction.userId,
        isOwner: item.reaction.isOwner,
        channelId: item.reaction.channelId,
        sessionKey: item.sourceSession.sessionKey,
        messageId: item.reaction.messageId,
        userPreview,
        recordedResponsePreview: toPreview(item.recordedResponse.content, 120),
        entryCount: item.slice.entryCount,
      };
    }),
  );

  const output = options.json
    ? JSON.stringify(
        { directory: store.directory, total: allCases.length, cases: enriched },
        null,
        2,
      )
    : formatCasesText(store.directory, allCases.length, enriched);

  await emitOutput(output, options.outPath);
}

async function runSessionsCommand(options: CliOptions): Promise<void> {
  const discovered = await discoverSessionFiles(options.sessionsDir);
  const limit = options.limit ?? 20;
  const selected = discovered.slice(0, limit);

  const summaries = await Promise.all(
    selected.map(async (item) => {
      try {
        const raw = await readFile(item.filePath, "utf8");
        const entries = parseSessionEntries(raw);
        const header = entries.find((entry) => entry.type === "session");
        const turns = extractSessionTurns(entries);
        const lastTurn = turns.at(-1);
        return {
          sessionId: header?.id ?? basename(item.filePath, ".jsonl"),
          sessionKey: item.sessionKey,
          filePath: item.filePath,
          updatedAt: item.mtimeIso,
          turnCount: turns.length,
          lastUserPreview: lastTurn ? toPreview(extractEventBody(lastTurn.userText), 100) : "",
          lastSentPreview: lastTurn?.discordSendContents.at(-1)
            ? toPreview(lastTurn.discordSendContents.at(-1)!, 100)
            : "",
        };
      } catch {
        return {
          sessionId: basename(item.filePath, ".jsonl"),
          sessionKey: item.sessionKey,
          filePath: item.filePath,
          updatedAt: item.mtimeIso,
          turnCount: 0,
          lastUserPreview: "",
          lastSentPreview: "",
        };
      }
    }),
  );

  const output = options.json
    ? JSON.stringify(
        { directory: options.sessionsDir, total: discovered.length, sessions: summaries },
        null,
        2,
      )
    : formatSessionsText(options.sessionsDir, discovered.length, summaries);

  await emitOutput(output, options.outPath);
}

async function runShowOrReplayCommand(options: CliOptions, isReplay: boolean): Promise<void> {
  if (!options.caseRef && !options.session) {
    throw new Error(`${options.command} requires either --case <id|path> or --session <path|id>`);
  }
  if (options.caseRef && options.session) {
    throw new Error("Specify either --case or --session, not both");
  }

  const provider = options.provider ?? options.defaultProvider;
  const model = options.model ?? options.defaultModel;
  const thinkingLevel = options.thinkingLevel ?? options.defaultThinkingLevel ?? "low";

  if (options.caseRef) {
    const store = new SessionEvalCaseStore({ agentDir: options.agentDir });
    const loaded = await store.loadCase(options.caseRef);
    if (!loaded) {
      throw new Error(`Feedback case not found: ${options.caseRef} (checked ${store.directory})`);
    }

    if (isReplay) {
      const result = await replayFeedbackCase(loaded, {
        profile: options.profile,
        provider,
        model,
        thinkingLevel,
        mode: options.mode,
        runtimeAgentDir: options.agentDir,
        captureProviderPayload: options.includeRawPayload,
      });
      const output = options.json
        ? JSON.stringify({ caseMeta: loaded.caseMeta, ...result }, null, 2)
        : formatReplayResultMarkdown(result, {
            title: `Feedback Case Replay (${loaded.caseMeta.caseId})`,
            includeTools: options.includeTools,
            includeProviderPayload: options.includeRawPayload,
            caseMeta: loaded.caseMeta,
          });
      await emitOutput(output, options.outPath);
      return;
    }

    const result = await inspectFeedbackCase(loaded, {
      profile: options.profile,
      provider,
      model,
      thinkingLevel,
      mode: options.mode,
      runtimeAgentDir: options.agentDir,
      captureProviderPayload: options.includeRawPayload,
    });
    const output = options.json
      ? JSON.stringify({ caseMeta: loaded.caseMeta, ...result }, null, 2)
      : formatContextInspectionMarkdown(result, {
          title: `Feedback Case Context (${loaded.caseMeta.caseId})`,
          includeTools: options.includeTools,
          includeProviderPayload: options.includeRawPayload,
          caseMeta: loaded.caseMeta,
        });
    await emitOutput(output, options.outPath);
    return;
  }

  const sessionTarget = await resolveSessionTarget(options.session!, options.sessionsDir);
  const raw = await readFile(sessionTarget.filePath, "utf8");
  const entries = parseSessionEntries(raw);
  const ownerFeaturesAllowed = sessionTarget.sessionKey.startsWith("discord-dm:");

  if (isReplay) {
    const result = await replaySessionEntries({
      entries,
      profile: options.profile,
      provider,
      model,
      thinkingLevel,
      sessionKey: sessionTarget.sessionKey,
      ownerFeaturesAllowed,
      turnIndex: options.turn ?? -1,
      mode: options.mode ?? "turn-start",
      runtimeAgentDir: options.agentDir,
      captureProviderPayload: options.includeRawPayload,
    });
    const output = options.json
      ? JSON.stringify({ sourceFile: sessionTarget.filePath, ...result }, null, 2)
      : formatReplayResultMarkdown(result, {
          title: `Session Replay (${basename(sessionTarget.filePath)})`,
          includeTools: options.includeTools,
          includeProviderPayload: options.includeRawPayload,
        });
    await emitOutput(output, options.outPath);
    return;
  }

  const result = await inspectSessionEntries({
    entries,
    profile: options.profile,
    provider,
    model,
    thinkingLevel,
    sessionKey: sessionTarget.sessionKey,
    ownerFeaturesAllowed,
    turnIndex: options.turn ?? -1,
    mode: options.mode ?? "turn-start",
    runtimeAgentDir: options.agentDir,
    captureProviderPayload: options.includeRawPayload,
  });
  const output = options.json
    ? JSON.stringify({ sourceFile: sessionTarget.filePath, ...result }, null, 2)
    : formatContextInspectionMarkdown(result, {
        title: `Session Context (${basename(sessionTarget.filePath)})`,
        includeTools: options.includeTools,
        includeProviderPayload: options.includeRawPayload,
      });
  await emitOutput(output, options.outPath);
}

async function discoverSessionFiles(sessionsDir: string): Promise<DiscoveredSessionFile[]> {
  let channelDirs: string[];
  try {
    channelDirs = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const found: DiscoveredSessionFile[] = [];
  for (const dir of channelDirs) {
    const dirPath = join(sessionsDir, dir);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    let sessionKey: string;
    try {
      sessionKey = decodeURIComponent(dir);
    } catch {
      sessionKey = dir;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(dirPath, file);
      try {
        const info = await stat(filePath);
        if (!info.isFile()) continue;
        found.push({
          filePath,
          sessionKey,
          mtimeMs: info.mtimeMs,
          mtimeIso: new Date(info.mtimeMs).toISOString(),
        });
      } catch {
        // Ignore unreadable files.
      }
    }
  }

  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function resolveSessionTarget(
  sessionRef: string,
  sessionsDir: string,
): Promise<{ readonly filePath: string; readonly sessionKey: string }> {
  const directPath = isAbsolute(sessionRef) ? sessionRef : resolve(sessionRef);
  try {
    const info = await stat(directPath);
    if (info.isFile()) {
      return {
        filePath: directPath,
        sessionKey: inferSessionKeyFromPath(directPath),
      };
    }
  } catch {
    // Fall back to searching discovered sessions.
  }

  const discovered = await discoverSessionFiles(sessionsDir);
  const matched = discovered.find(
    (entry) => entry.filePath.includes(sessionRef) || basename(entry.filePath).includes(sessionRef),
  );
  if (!matched) {
    throw new Error(`Session not found for "${sessionRef}" under ${sessionsDir}`);
  }
  return { filePath: matched.filePath, sessionKey: matched.sessionKey };
}

function inferSessionKeyFromPath(filePath: string): string {
  const parentName = basename(dirname(filePath));
  try {
    return decodeURIComponent(parentName);
  } catch {
    return parentName;
  }
}

function formatCasesText(
  directory: string,
  total: number,
  cases: readonly {
    readonly caseId: string;
    readonly occurredAt: string;
    readonly emoji: string;
    readonly userId: string;
    readonly isOwner: boolean;
    readonly sessionKey: string;
    readonly messageId: string;
    readonly userPreview: string;
    readonly recordedResponsePreview: string;
    readonly entryCount: number;
  }[],
): string {
  if (cases.length === 0) {
    return `No negative-feedback cases recorded in ${directory}`;
  }
  const lines: string[] = [];
  lines.push(`Feedback Cases (${cases.length}/${total}) in ${directory}:`);
  lines.push("");
  for (const item of cases) {
    lines.push(
      `- ${item.caseId} [${item.emoji}] at=${item.occurredAt} session=${item.sessionKey} user=${item.userId}${item.isOwner ? "(owner)" : ""} msg=${item.messageId} entries=${item.entryCount}`,
    );
    if (item.userPreview) {
      lines.push(`  user: ${item.userPreview}`);
    }
    lines.push(`  bot : ${item.recordedResponsePreview}`);
  }
  return lines.join("\n");
}

function formatSessionsText(
  directory: string,
  total: number,
  sessions: readonly {
    readonly sessionId: string;
    readonly sessionKey: string;
    readonly filePath: string;
    readonly updatedAt: string;
    readonly turnCount: number;
    readonly lastUserPreview: string;
    readonly lastSentPreview: string;
  }[],
): string {
  if (sessions.length === 0) {
    return `No Pi session files found in ${directory}`;
  }
  const lines: string[] = [];
  lines.push(`Pi Sessions (${sessions.length}/${total}) in ${directory}:`);
  lines.push("");
  for (const item of sessions) {
    lines.push(
      `- ${item.sessionId} updated=${item.updatedAt} session=${item.sessionKey} turns=${item.turnCount}`,
    );
    lines.push(`  file: ${item.filePath}`);
    if (item.lastUserPreview) {
      lines.push(`  last user: ${item.lastUserPreview}`);
    }
    if (item.lastSentPreview) {
      lines.push(`  last bot : ${item.lastSentPreview}`);
    }
  }
  return lines.join("\n");
}

function extractEventBody(userText: string): string {
  const withoutMetadata = userText.replace(/<event-metadata>[\s\S]*?<\/event-metadata>/gu, "");
  return withoutMetadata.trim() || userText;
}

function toPreview(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/gu, " ").trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}

async function emitOutput(content: string, outPath?: string): Promise<void> {
  if (outPath) {
    await mkdir(dirname(resolve(outPath)), { recursive: true });
    await writeFile(outPath, `${content}\n`, "utf8");
    console.error(`[inspect-context] Wrote output to ${outPath}`);
  }
  console.log(content);
}

async function main(): Promise<void> {
  const options = await parseOptions(process.argv.slice(2));
  if (options.command === "cases") {
    await runCasesCommand(options);
  } else if (options.command === "sessions") {
    await runSessionsCommand(options);
  } else if (options.command === "show") {
    await runShowOrReplayCommand(options, false);
  } else {
    await runShowOrReplayCommand(options, true);
  }
}

await main();
