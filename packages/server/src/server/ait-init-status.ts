import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveGitRevParsePath } from "../utils/git-rev-parse-path.js";
import { runGitCommand } from "../utils/run-git-command.js";

const READ_ONLY_GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
} as const;

/**
 * Resolve the directory passed to `ait`: Git's worktree root when the path is
 * in a repository, otherwise the path itself. A non-Git child does not
 * inherit an AIT database from an unrelated parent directory.
 */
export async function resolveAitRootPath(projectRootPath: string): Promise<string> {
  const resolvedProjectRootPath = resolve(projectRootPath);
  try {
    const { stdout } = await runGitCommand(["rev-parse", "--show-toplevel"], {
      cwd: resolvedProjectRootPath,
      envOverlay: READ_ONLY_GIT_ENV,
    });
    return resolveGitRevParsePath(resolvedProjectRootPath, stdout) ?? resolvedProjectRootPath;
  } catch {
    return resolvedProjectRootPath;
  }
}

/**
 * Cheap, upfront signal for whether a project has ever run `ait init` —
 * checks for `.ait/ait.db` specifically, not just the `.ait` directory
 * (TrackerSyncManager's own directoryExists check treats a bare `.ait/` as
 * "attached" for a looser, file-watching purpose; a directory with no db
 * file inside it is not actually initialised). Re-checked fresh on every
 * call by design (pas-2KY5X.28) — running `ait init` while the app is open
 * must flip this the moment the next project descriptor is built, not stay
 * stale behind some other cache's invalidation.
 */
export async function checkAitInitialized(projectRootPath: string): Promise<boolean> {
  const aitRootPath = await resolveAitRootPath(projectRootPath);
  try {
    await access(join(aitRootPath, ".ait", "ait.db"));
    return true;
  } catch {
    return false;
  }
}
