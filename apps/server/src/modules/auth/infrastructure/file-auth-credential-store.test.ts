import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTempDir } from "../../../testing/temp-dir";
import { FileAuthCredentialStore } from "./file-auth-credential-store";
import {
  AuthCredentialCipher,
  authCredentialAdditionalData,
  authCredentialKeyPath,
} from "./auth-credential-cipher";

test("encrypts every credential value and lists only metadata", async () => {
  await using temp = await createTempDir("klein-auth-store-");
  const store = new FileAuthCredentialStore(temp.path);

  const summary = await store.save("123", {
    service: "github",
    label: "GitHub",
    fields: [
      { key: "username", label: "ユーザー名" },
      { key: "token", label: "トークン", env: "GH_TOKEN" },
    ],
    values: { username: "octocat", token: "ghp_very-secret-token" },
    updatedAt: "2026-11-22T00:00:00.000Z",
  });

  assert.deepEqual(summary, {
    service: "github",
    label: "GitHub",
    fields: [
      { key: "username", label: "ユーザー名" },
      { key: "token", label: "トークン", env: "GH_TOKEN" },
    ],
    updatedAt: "2026-11-22T00:00:00.000Z",
  });

  const filePath = join(temp.path, "users", "123", "credentials", "auth", "github.json");
  const raw = await readFile(filePath, "utf8");
  assert.doesNotMatch(raw, /octocat|ghp_very-secret-token/u);
  assert.match(raw, /"algorithm": "aes-256-gcm"/u);
  if (process.platform !== "win32") {
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.equal((await stat(authCredentialKeyPath(temp.path))).mode & 0o777, 0o600);
  }

  assert.deepEqual(await store.read("123", "github"), {
    service: "github",
    label: "GitHub",
    fields: [
      { key: "username", label: "ユーザー名" },
      { key: "token", label: "トークン", env: "GH_TOKEN" },
    ],
    values: { username: "octocat", token: "ghp_very-secret-token" },
    updatedAt: "2026-11-22T00:00:00.000Z",
  });
  assert.deepEqual(await store.list("123"), [summary]);
});

test("replaces a service and deletes it", async () => {
  await using temp = await createTempDir("klein-auth-store-replace-");
  const store = new FileAuthCredentialStore(temp.path);
  const base = {
    service: "example",
    label: "Example",
    fields: [{ key: "token", label: "Token" }],
  };

  await store.save("123", {
    ...base,
    values: { token: "first-value" },
    updatedAt: "2026-11-22T00:00:00.000Z",
  });
  await store.save("123", {
    ...base,
    values: { token: "second-value" },
    updatedAt: "2026-11-22T01:00:00.000Z",
  });

  assert.equal((await store.read("123", "example"))?.values.token, "second-value");
  assert.equal(await store.delete("123", "example"), true);
  assert.equal(await store.delete("123", "example"), false);
  assert.equal(await store.read("123", "example"), undefined);
});

test("binds ciphertext to the user and service", async () => {
  await using temp = await createTempDir("klein-auth-cipher-");
  const cipher = new AuthCredentialCipher(authCredentialKeyPath(temp.path));
  const payload = cipher.encrypt("secret", authCredentialAdditionalData("123", "github"));

  assert.equal(cipher.decrypt(payload, authCredentialAdditionalData("123", "github")), "secret");
  assert.throws(
    () => cipher.decrypt(payload, authCredentialAdditionalData("456", "github")),
    /unable to authenticate|bad decrypt|Unsupported state/iu,
  );
});

test("refuses to decrypt after the key file is lost", async () => {
  await using temp = await createTempDir("klein-auth-cipher-lost-");
  const keyPath = authCredentialKeyPath(temp.path);
  const payload = new AuthCredentialCipher(keyPath).encrypt(
    "secret",
    authCredentialAdditionalData("123", "github"),
  );
  await rm(keyPath);

  const fresh = new AuthCredentialCipher(keyPath);
  assert.throws(
    () => fresh.decrypt(payload, authCredentialAdditionalData("123", "github")),
    /Credential key is missing/u,
  );
});
