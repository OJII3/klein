// Bun's own type definitions replace the global fetch type and conflict with
// the Node types used elsewhere in the server, so only the test API is declared.
declare module "bun:test" {
  type TestCallback = () => void | Promise<void>;

  export function test(name: string, callback: TestCallback): void;
}
