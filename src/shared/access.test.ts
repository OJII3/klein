import assert from "node:assert/strict";
import test from "node:test";

import {
  isAccessAllowed,
  isOwnerAccessScope,
  ownerAccessScope,
  PUBLIC_ACCESS_SCOPE,
} from "./access";

test("access levels allow everyone or owner sessions only", () => {
  assert.equal(isAccessAllowed("allow", false), true);
  assert.equal(isAccessAllowed("allow", true), true);
  assert.equal(isAccessAllowed("owner", false), false);
  assert.equal(isAccessAllowed("owner", true), true);
  assert.equal(isAccessAllowed("deny", false), false);
  assert.equal(isAccessAllowed("deny", true), false);
});

test("access scopes distinguish public from a specific owner", () => {
  assert.equal(ownerAccessScope("123"), "owner:123");
  assert.equal(isOwnerAccessScope("owner:123", "123"), true);
  assert.equal(isOwnerAccessScope("owner:123", "456"), false);
  assert.equal(isOwnerAccessScope(PUBLIC_ACCESS_SCOPE, "123"), false);
  assert.equal(isOwnerAccessScope(undefined, "123"), false);
  assert.equal(isOwnerAccessScope("owner:123", undefined), false);
});
