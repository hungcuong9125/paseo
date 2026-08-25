import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCommandResult } from "../utils/run-git-command.js";

const runGitCommandMock = vi.hoisted(() => vi.fn());

vi.mock("../utils/run-git-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/run-git-command.js")>();
  return { ...actual, runGitCommand: runGitCommandMock };
});

import { checkAitInitialized } from "./ait-init-status.js";

describe("checkAitInitialized transient Git failures", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    runGitCommandMock.mockReset();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeGitProjectRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ait-init-status-transient-test-")));
    let current = dirname(root);
    while (true) {
      if (existsSync(join(current, ".ait"))) {
        throw new Error(`Fixture root ${root} has an unexpected .ait ancestor at ${current}`);
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    tempDirs.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    return root;
  }

  function gitResult(stdout: string): GitCommandResult {
    return { stdout, stderr: "", truncated: false, exitCode: 0, signal: null };
  }

  it("does not memoize a transient Git command failure", async () => {
    const root = makeGitProjectRoot();
    const child = join(root, "packages", "server");
    mkdirSync(child, { recursive: true });
    mkdirSync(join(root, ".ait"));
    writeFileSync(join(root, ".ait", "ait.db"), "");

    runGitCommandMock
      .mockRejectedValueOnce(new Error("Git scheduler temporarily unavailable"))
      .mockResolvedValue(gitResult(`${root}\n`));

    await expect(checkAitInitialized(child)).resolves.toBe(false);
    await expect(checkAitInitialized(child)).resolves.toBe(true);
    expect(runGitCommandMock).toHaveBeenCalledTimes(2);
    expect(runGitCommandMock).toHaveBeenLastCalledWith(
      ["rev-parse", "--show-toplevel"],
      expect.objectContaining({ acceptExitCodes: [0, 128] }),
    );
  });
});
