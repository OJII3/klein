import assert from "node:assert/strict";
import test from "node:test";

import {
  accessScopeUserId,
  isAccessAllowed,
  isOwnerAccessScope,
  ownerAccessScope,
  parseAccessScope,
  PUBLIC_ACCESS_SCOPE,
  userAccessScope,
} from "./access";

test("access levels allow everyone or owner sessions only", () => {
  assert.equal(isAccessAllowed("allow", false), true);
  assert.equal(isAccessAllowed("allow", true), true);
  assert.equal(isAccessAllowed("owner", false), false);
  assert.equal(isAccessAllowed("owner", true), true);
  assert.equal(isAccessAllowed("deny", false), false);
  assert.equal(isAccessAllowed("deny", true), false);
});

test("access scopes distinguish public, an owner, and a linked user", () => {
  assert.equal(ownerAccessScope("123"), "owner:123");
  assert.equal(userAccessScope("456"), "user:456");
  assert.equal(parseAccessScope("public"), PUBLIC_ACCESS_SCOPE);
  assert.equal(parseAccessScope("owner:123"), "owner:123");
  assert.equal(parseAccessScope("user:456"), "user:456");
  assert.equal(parseAccessScope("owner:"), undefined);
  assert.equal(parseAccessScope("user:"), undefined);
  assert.equal(parseAccessScope("invalid"), undefined);
  assert.equal(parseAccessScope(123), undefined);
  assert.equal(isOwnerAccessScope("owner:123", "123"), true);
  assert.equal(isOwnerAccessScope("owner:123", "456"), false);
  assert.equal(isOwnerAccessScope("user:123", "123"), false);
  assert.equal(isOwnerAccessScope(PUBLIC_ACCESS_SCOPE, "123"), false);
  assert.equal(isOwnerAccessScope(undefined, "123"), false);
  assert.equal(isOwnerAccessScope("owner:123", undefined), false);
});

test("access scopes expose the user that owns the private session", () => {
  assert.equal(accessScopeUserId("owner:123"), "123");
  assert.equal(accessScopeUserId("user:456"), "456");
  assert.equal(accessScopeUserId(PUBLIC_ACCESS_SCOPE), undefined);
  assert.equal(accessScopeUserId(undefined), undefined);
});
