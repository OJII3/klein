import { createLogger } from "./logger";
import { configurePiPackageDir } from "./pi-package-dir";

configurePiPackageDir();

export async function bootstrap(): Promise<void> {
  configurePiPackageDir();
  const { bootstrapApplication } = await import("./bootstrap-application");
  await bootstrapApplication();
}

try {
  const args = process.argv.slice(2);
  if (args[0] === "mcp") {
    try {
      const { runMcpCommand } = await import("./mcp-cli");
      process.exitCode = await runMcpCommand(args.slice(1));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else {
    await bootstrap();
  }
} catch (error) {
  createLogger().fatal({ err: error, event: "bootstrap_failed" }, "Klein failed to start");
  process.exitCode = 1;
}
