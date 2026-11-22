import assert from "node:assert/strict";
import test from "node:test";

import { renderSystemdUserUnit } from "./systemd-user-unit";

test("starts Bun inside the flake devShell when Nix is available", () => {
  const unit = renderSystemdUserUnit({
    repositoryRoot: "/srv/klein",
    bunBinary: "/usr/local/bin/bun",
    nixBinary: "/nix/var/nix/profiles/default/bin/nix",
  });

  assert.match(unit, /^WorkingDirectory=\/srv\/klein$/mu);
  assert.match(
    unit,
    /^ExecStart="\/nix\/var\/nix\/profiles\/default\/bin\/nix" "develop" "--command" "bun" "dist\/klein"$/mu,
  );
  assert.match(unit, /^Restart=on-failure$/mu);
  assert.match(unit, /^KillSignal=SIGTERM$/mu);
  assert.match(unit, /^WantedBy=default\.target$/mu);
  assert.ok(unit.endsWith("\n"));
});

test("starts the built bundle directly without Nix", () => {
  const unit = renderSystemdUserUnit({
    repositoryRoot: "/srv/klein",
    bunBinary: "/usr/local/bin/bun",
  });

  assert.match(unit, /^ExecStart="\/usr\/local\/bin\/bun" "dist\/klein"$/mu);
});

test("escapes spaces and systemd specifiers in paths", () => {
  const unit = renderSystemdUserUnit({
    repositoryRoot: "/srv/with space/100%",
    bunBinary: '/opt/b"un',
  });

  assert.match(unit, /^WorkingDirectory=\/srv\/with space\/100%%$/mu);
  assert.match(unit, /^ExecStart="\/opt\/b\\"un" "dist\/klein"$/mu);
});
