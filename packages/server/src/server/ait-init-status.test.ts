import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkAitInitialized, resolveAitRootPath } from "./ait-init-status.js";

describe("checkAitInitialized", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeProjectRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ait-init-status-test-")));
    assertNoAitAbove(root);
    tempDirs.push(root);
    return root;
  }

  function assertNoAitAbove(root: string): void {
    let current = dirname(root);
    while (true) {
      if (existsSync(join(current, ".ait"))) {
        throw new Error(`Fixture root ${root} has an unexpected .ait ancestor at ${current}`);
      }
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }

  function makeGitProjectRoot(): string {
    const root = makeProjectRoot();
    execFileSync("git", ["init", "-q"], { cwd: root });
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

  it("resolves the database from a Git ancestor root", async () => {
    const root = makeGitProjectRoot();
    const child = join(root, "packages", "server");
    mkdirSync(child, { recursive: true });
    mkdirSync(join(root, ".ait"));
    writeFileSync(join(root, ".ait", "ait.db"), "");

    await expect(resolveAitRootPath(child)).resolves.toBe(root);
    await expect(checkAitInitialized(child)).resolves.toBe(true);
  });

  it("tracks appearance and deletion at the resolved Git root", async () => {
    const root = makeGitProjectRoot();
    const child = join(root, "agent", "workdir");
    mkdirSync(child, { recursive: true });

    await expect(resolveAitRootPath(child)).resolves.toBe(root);
    await expect(checkAitInitialized(child)).resolves.toBe(false);

    mkdirSync(join(root, ".ait"));
    const databasePath = join(root, ".ait", "ait.db");
    writeFileSync(databasePath, "");
    await expect(checkAitInitialized(child)).resolves.toBe(true);

    rmSync(databasePath);
    await expect(checkAitInitialized(child)).resolves.toBe(false);
  });

  it("does not cross a nested Git boundary", async () => {
    const outerRoot = makeGitProjectRoot();
    mkdirSync(join(outerRoot, ".ait"));
    writeFileSync(join(outerRoot, ".ait", "ait.db"), "");
    const nestedRoot = join(outerRoot, "nested");
    mkdirSync(nestedRoot);
    execFileSync("git", ["init", "-q"], { cwd: nestedRoot });

    await expect(resolveAitRootPath(nestedRoot)).resolves.toBe(nestedRoot);
    await expect(checkAitInitialized(nestedRoot)).resolves.toBe(false);
  });
});
