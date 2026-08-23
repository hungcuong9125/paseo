import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkAitInitialized } from "./ait-init-status.js";

describe("checkAitInitialized", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeProjectRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ait-init-status-test-")));
    tempDirs.push(root);
    return root;
  }

  it("returns true when .ait/ait.db exists", async () => {
    const root = makeProjectRoot();
    mkdirSync(join(root, ".ait"));
    writeFileSync(
      join(root, ".ait", "ait.db"),
      "not a real sqlite file, existence is all that matters",
    );

    await expect(checkAitInitialized(root)).resolves.toBe(true);
  });

  it("returns false when the project root has no .ait directory at all", async () => {
    const root = makeProjectRoot();

    await expect(checkAitInitialized(root)).resolves.toBe(false);
  });

  it("returns false when .ait exists but ait.db doesn't — a bare .ait/ dir is not actually initialised", async () => {
    const root = makeProjectRoot();
    mkdirSync(join(root, ".ait"));

    await expect(checkAitInitialized(root)).resolves.toBe(false);
  });

  it("returns false for a project root that doesn't exist on disk at all", async () => {
    await expect(checkAitInitialized("/nonexistent/definitely-not-a-real-path")).resolves.toBe(
      false,
    );
  });

  it("re-checks fresh on every call — flips to true the moment ait init actually happens", async () => {
    const root = makeProjectRoot();

    await expect(checkAitInitialized(root)).resolves.toBe(false);

    mkdirSync(join(root, ".ait"));
    writeFileSync(join(root, ".ait", "ait.db"), "");

    await expect(checkAitInitialized(root)).resolves.toBe(true);
  });
});
