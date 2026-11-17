import assert from "node:assert/strict";
import test from "node:test";

import { createShutdownRunner } from "./shutdown";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve?.() };
}

test("runs the shutdown once and exits with the requested code", async () => {
  const signals: string[] = [];
  const exitCodes: number[] = [];
  const run = createShutdownRunner({
    timeoutMs: 1_000,
    shutdown: (signal) => {
      signals.push(signal);
      return Promise.resolve();
    },
    onTimeout: () => {
      throw new Error("shutdown must not time out");
    },
    onError: (error) => {
      throw error;
    },
    exit: (code) => exitCodes.push(code),
  });

  await Promise.all([run("SIGTERM"), run("SIGINT")]);

  assert.deepEqual(signals, ["SIGTERM"]);
  assert.deepEqual(exitCodes, [0]);
});

test("exits with 1 when the shutdown fails", async () => {
  const events: string[] = [];
  const run = createShutdownRunner({
    timeoutMs: 1_000,
    shutdown: () => Promise.reject(new Error("close failed")),
    onTimeout: () => events.push("timeout"),
    onError: (error, signal) =>
      events.push(`error:${signal}:${error instanceof Error ? error.message : String(error)}`),
    exit: (code) => events.push(`exit:${code}`),
  });

  await run("SIGTERM");

  assert.deepEqual(events, ["error:SIGTERM:close failed", "exit:1"]);
});

test("exits with 1 when the shutdown does not finish in time", async () => {
  const events: string[] = [];
  const stuck = deferred();
  const run = createShutdownRunner({
    timeoutMs: 10,
    shutdown: () => stuck.promise,
    onTimeout: (signal) => events.push(`timeout:${signal}`),
    onError: (error) => events.push(`error:${String(error)}`),
    exit: (code) => events.push(`exit:${code}`),
  });

  void run("SIGTERM");
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });

  assert.deepEqual(events, ["timeout:SIGTERM", "exit:1"]);
  stuck.resolve();
});

test("keeps the exit code passed for a failed startup", async () => {
  const exitCodes: number[] = [];
  const run = createShutdownRunner({
    timeoutMs: 1_000,
    shutdown: () => Promise.resolve(),
    onTimeout: () => {},
    onError: () => {},
    exit: (code) => exitCodes.push(code),
  });

  await run("startup_failed", 1);

  assert.deepEqual(exitCodes, [1]);
});
