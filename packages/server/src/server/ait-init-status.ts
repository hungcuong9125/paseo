import { access } from "node:fs/promises";
import { join } from "node:path";

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
  try {
    await access(join(projectRootPath, ".ait", "ait.db"));
    return true;
  } catch {
    return false;
  }
}
