export interface SystemdUserUnitOptions {
  readonly repositoryRoot: string;
  readonly bunBinary: string;
  /** Absolute path to Nix. When set, the unit starts Bun inside the flake devShell. */
  readonly nixBinary?: string;
}

/**
 * Renders the unit that runs the built server from the repository root.
 *
 * `.env` and relative `runtime.*` paths resolve from `WorkingDirectory`, so the
 * unit must always run from the checkout that owns `dist/klein`.
 */
export function renderSystemdUserUnit(options: SystemdUserUnitOptions): string {
  const execStart = options.nixBinary
    ? [options.nixBinary, "develop", "--command", "bun", "dist/klein"]
    : [options.bunBinary, "dist/klein"];

  return [
    "[Unit]",
    "Description=Klein Discord agent",
    "Documentation=https://github.com/ojii3/klein",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${escapeUnitValue(options.repositoryRoot)}`,
    "Environment=NODE_ENV=production",
    `ExecStart=${execStart.map((argument) => quoteExecArgument(argument)).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5s",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=60s",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** `%` starts a systemd specifier, so a literal percent must be doubled. */
function escapeUnitValue(value: string): string {
  return value.replaceAll("%", "%%");
}

function quoteExecArgument(value: string): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `"${escaped}"`;
}
