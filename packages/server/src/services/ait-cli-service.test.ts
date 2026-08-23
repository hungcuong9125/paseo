import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AitCliError, createAitService, type AitService } from "./ait-cli-service.js";

// Exercises the real `ait` binary (installed on this host, see the `ait` skill contract) against
// a scratch project directory per test. No CLI mocking: correctness here is entirely about
// whether we parse and map ait's actual JSON shapes right.

describe("createAitService", () => {
  let cwd: string;
  let service: AitService;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "ait-cli-service-test-"));
    service = createAitService();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reports uninitialised for a project with no .ait database", async () => {
    await expect(service.listTrackers({ cwd })).rejects.toMatchObject({
      code: "uninitialised",
    });
  });

  it("initialises a tracker and lists no trackers", async () => {
    const result = await service.initTracker({ cwd });
    expect(result.initialised).toBe(true);

    const list = await service.listTrackers({ cwd });
    expect(list).toEqual({ trackers: [], hiddenCount: 0 });
  });

  it("passes through ait list total_count for paginated results", async () => {
    await service.initTracker({ cwd });
    await service.createTracker({ cwd, input: { title: "First" } });
    await service.createTracker({ cwd, input: { title: "Second" } });

    const result = await service.listTrackers({ cwd, all: true, limit: 1 });

    expect(result.pageInfo).toMatchObject({ totalCount: 2, hasMore: true });
  });

  it("passes the creation-time sort to ait list", async () => {
    await service.initTracker({ cwd });
    const first = await service.createTracker({ cwd, input: { title: "First" } });
    const second = await service.createTracker({ cwd, input: { title: "Second" } });

    const result = await service.listTrackers({ cwd, all: true, sort: "newest" });

    expect(result.trackers.map((tracker) => tracker.id)).toEqual([second.id, first.id]);
  });

  it("filters list arguments by priority", async () => {
    await service.initTracker({ cwd });
    const p0 = await service.createTracker({
      cwd,
      input: { title: "Urgent", priority: "P0" },
    });
    await service.createTracker({ cwd, input: { title: "Normal", priority: "P2" } });

    const result = await service.listTrackers({ cwd, all: true, priority: "P0" });

    expect(result.trackers.map((tracker) => tracker.id)).toEqual([p0.id]);
  });

  it("fails loudly when an ait binary rejects pagination", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "ait-old-cli-test-"));
    const fakeAit = join(binDir, "ait");
    writeFileSync(
      fakeAit,
      '#!/bin/sh\ncase " $* " in\n  *" --limit "*) echo "flag provided but not defined: --limit" >&2; exit 2;;\n  *) printf \'%s\\n\' \'{"issues":[],"hidden_count":0}\';;\nesac\n',
    );
    chmodSync(fakeAit, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      const oldCliService = createAitService();
      await expect(oldCliService.listTrackers({ cwd, limit: 1 })).rejects.toMatchObject({
        code: "unknown",
        message: "flag provided but not defined: --limit",
      });
      await expect(oldCliService.listTrackers({ cwd, limit: 1 })).rejects.toMatchObject({
        code: "unknown",
        message: "flag provided but not defined: --limit",
      });
    } finally {
      process.env.PATH = originalPath;
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("probes the current binary for sort support without latching the result", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "ait-sort-probe-test-"));
    const fakeAit = join(binDir, "ait");
    const writeFakeAit = (supportsSort: boolean) => {
      writeFileSync(
        fakeAit,
        `#!/bin/sh
case " $* " in
  *" --version "*) printf '%s\\n' 'dev';;
  *" list --help "*) printf '%s\\n' 'Usage: ait list [flags]${supportsSort ? " --sort <order>" : ""}';;
  *) printf '%s\\n' '{"issues":[],"hidden_count":0}';;
esac
`,
      );
      chmodSync(fakeAit, 0o755);
    };
    writeFakeAit(false);
    const originalPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      const probeService = createAitService();
      expect(probeService.supportsSort).toBeDefined();
      await expect(probeService.supportsSort!()).resolves.toBe(false);

      writeFakeAit(true);
      await expect(probeService.supportsSort!()).resolves.toBe(true);
    } finally {
      process.env.PATH = originalPath;
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("probes sort support correctly even when the daemon's own cwd has no valid ait prefix (pas-2KY5X.35)", async () => {
    // A GUI-launched daemon's process cwd is `/` — an empty basename that
    // fails ait's project-prefix validation even for `--db :memory:`. Real
    // binary, no faking (same posture as every other test in this file):
    // this only proves anything if the probe stops depending on whatever
    // directory happens to be current when it runs.
    const originalCwd = process.cwd();
    try {
      process.chdir("/");
      const probeService = createAitService();
      await expect(probeService.supportsSort!()).resolves.toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("creates, shows, and lists an tracker", async () => {
    await service.initTracker({ cwd });

    const created = await service.createTracker({
      cwd,
      input: { title: "Fix the thing", priority: "P1", description: "Because it's broken" },
    });
    expect(created.title).toBe("Fix the thing");
    expect(created.priority).toBe("P1");
    expect(created.status).toBe("open");
    expect(created.type).toBe("task");
    expect(created.parentId).toBeNull();

    const shown = await service.showTracker({ cwd, trackerId: created.id });
    expect(shown.title).toBe("Fix the thing");
    expect(shown.description).toBe("Because it's broken");
    expect(shown.children).toEqual([]);
    expect(shown.blockedBy).toEqual([]);
    expect(shown.notes).toEqual([]);

    const list = await service.listTrackers({ cwd });
    expect(list.trackers).toEqual([created]);
  });

  it("keeps parentId correct across status mutations (update/close/reopen)", async () => {
    await service.initTracker({ cwd });

    const epic = await service.createTracker({
      cwd,
      input: { title: "Epic", trackerType: "epic" },
    });
    const task = await service.createTracker({
      cwd,
      input: { title: "Task under epic", parentId: epic.id },
    });
    expect(task.parentId).toBe(epic.id);

    const started = await service.updateTracker({
      cwd,
      trackerId: task.id,
      input: { status: "in_progress" },
    });
    expect(started.status).toBe("in_progress");
    expect(started.parentId).toBe(epic.id);

    expect(task.createdAt).toBeTruthy();
    expect(task.closedAt).toBeNull();

    const closed = await service.closeTracker({ cwd, trackerId: task.id });
    expect(closed.status).toBe("closed");
    expect(closed.parentId).toBe(epic.id);
    expect(closed.closedAt).toBeTruthy();

    const reopened = await service.reopenTracker({ cwd, trackerId: task.id });
    expect(reopened.status).toBe("open");
    expect(reopened.parentId).toBe(epic.id);
    // `ait` clears `closed_at` on reopen — it marks "currently closed", not "was ever closed".
    expect(reopened.closedAt).toBeNull();

    const cancelled = await service.cancelTracker({ cwd, trackerId: task.id });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.parentId).toBe(epic.id);
    // `ait` never sets `closed_at` for a cancellation — only for the `closed` status.
    expect(cancelled.closedAt).toBeNull();

    const reopenedFromCancelled = await service.reopenTracker({ cwd, trackerId: task.id });
    expect(reopenedFromCancelled.status).toBe("open");
    expect(reopenedFromCancelled.parentId).toBe(epic.id);
  });

  it("shows children on the parent after creating a child tracker", async () => {
    await service.initTracker({ cwd });
    const epic = await service.createTracker({
      cwd,
      input: { title: "Epic", trackerType: "epic" },
    });
    const task = await service.createTracker({
      cwd,
      input: { title: "Task", parentId: epic.id },
    });

    const shown = await service.showTracker({ cwd, trackerId: epic.id });
    expect(shown.children).toHaveLength(1);
    expect(shown.children[0]).toMatchObject({
      id: task.id,
      title: "Task",
      type: "task",
      status: "open",
      priority: "P2",
      parentId: epic.id,
    });
    expect(shown.children[0].claimedBy).toBeNull();
    expect(shown.children[0].updatedAt).toBeTruthy();
  });

  it("excludes closed trackers from the default list but includes them with all", async () => {
    await service.initTracker({ cwd });
    const tracker = await service.createTracker({ cwd, input: { title: "Will be closed" } });
    await service.closeTracker({ cwd, trackerId: tracker.id });

    const openOnly = await service.listTrackers({ cwd });
    expect(openOnly.trackers).toEqual([]);
    expect(openOnly.hiddenCount).toBe(1);

    const all = await service.listTrackers({ cwd, all: true });
    expect(all.trackers.map((entry) => entry.id)).toEqual([tracker.id]);
  });

  it("adds a note and reads it back through show", async () => {
    await service.initTracker({ cwd });
    const tracker = await service.createTracker({ cwd, input: { title: "Needs a note" } });

    const note = await service.addNote({
      cwd,
      trackerId: tracker.id,
      body: "Investigated, root cause is X",
    });
    expect(note.body).toBe("Investigated, root cause is X");
    expect(note.id).toBeTruthy();
    expect(note.createdAt).toBeTruthy();

    const shown = await service.showTracker({ cwd, trackerId: tracker.id });
    expect(shown.notes).toEqual([note]);
  });

  it("rejects with not_found for a missing tracker id", async () => {
    await service.initTracker({ cwd });
    await expect(service.showTracker({ cwd, trackerId: "nope-00000" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects with cli_missing when ait is not on PATH", async () => {
    await service.initTracker({ cwd });
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const isolatedService = createAitService();
      await expect(isolatedService.listTrackers({ cwd })).rejects.toMatchObject({
        code: "cli_missing",
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("throws AitCliError instances with a readable message", async () => {
    const error = await service.listTrackers({ cwd }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AitCliError);
    expect((error as AitCliError).message.length).toBeGreaterThan(0);
  });

  it("lists ready ids, excluding a blocked tracker and closed trackers", async () => {
    await service.initTracker({ cwd });
    const unblocked = await service.createTracker({ cwd, input: { title: "Ready to go" } });
    const blocker = await service.createTracker({ cwd, input: { title: "Blocks the other" } });
    const blocked = await service.createTracker({ cwd, input: { title: "Waits on blocker" } });
    const willClose = await service.createTracker({ cwd, input: { title: "Will be closed" } });
    await service.closeTracker({ cwd, trackerId: willClose.id });

    execFileSync("ait", ["dep", "add", blocked.id, blocker.id], { cwd });

    const ready = await service.listReadyIds({ cwd });
    expect(ready).toEqual(expect.arrayContaining([unblocked.id, blocker.id]));
    expect(ready).not.toContain(blocked.id);
    expect(ready).not.toContain(willClose.id);
  });

  it("deletes a childless tracker permanently", async () => {
    await service.initTracker({ cwd });
    const task = await service.createTracker({ cwd, input: { title: "Throwaway" } });

    const deletedIds = await service.deleteTracker({ cwd, trackerId: task.id });
    expect(deletedIds).toEqual([task.id]);

    await expect(service.showTracker({ cwd, trackerId: task.id })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("refuses to delete a tracker with children unless cascade is set", async () => {
    await service.initTracker({ cwd });
    const epic = await service.createTracker({
      cwd,
      input: { title: "Epic", trackerType: "epic" },
    });
    await service.createTracker({ cwd, input: { title: "Child", parentId: epic.id } });

    await expect(service.deleteTracker({ cwd, trackerId: epic.id })).rejects.toMatchObject({
      code: "validation",
    });

    // The epic (and its child) must still exist after the refused delete.
    const shown = await service.showTracker({ cwd, trackerId: epic.id });
    expect(shown.children).toHaveLength(1);
  });

  it("cascade-deletes a tracker and every descendant", async () => {
    await service.initTracker({ cwd });
    const epic = await service.createTracker({
      cwd,
      input: { title: "Epic", trackerType: "epic" },
    });
    const child = await service.createTracker({
      cwd,
      input: { title: "Child", parentId: epic.id },
    });

    const deletedIds = await service.deleteTracker({ cwd, trackerId: epic.id, cascade: true });
    expect(deletedIds).toEqual(expect.arrayContaining([epic.id, child.id]));

    await expect(service.showTracker({ cwd, trackerId: epic.id })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(service.showTracker({ cwd, trackerId: child.id })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
