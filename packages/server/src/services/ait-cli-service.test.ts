import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("creates, shows, and lists an tracker", async () => {
    await service.initTracker({ cwd });

    const created = await service.createTracker({
      cwd,
      input: { title: "Fix the thing", priority: "P1" },
    });
    expect(created.title).toBe("Fix the thing");
    expect(created.priority).toBe("P1");
    expect(created.status).toBe("open");
    expect(created.type).toBe("task");
    expect(created.parentId).toBeNull();

    const shown = await service.showTracker({ cwd, trackerId: created.id });
    expect(shown.title).toBe("Fix the thing");
    expect(shown.description).toBeNull();
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

    const closed = await service.closeTracker({ cwd, trackerId: task.id });
    expect(closed.status).toBe("closed");
    expect(closed.parentId).toBe(epic.id);

    const reopened = await service.reopenTracker({ cwd, trackerId: task.id });
    expect(reopened.status).toBe("open");
    expect(reopened.parentId).toBe(epic.id);

    const cancelled = await service.cancelTracker({ cwd, trackerId: task.id });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.parentId).toBe(epic.id);
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
    expect(shown.children).toEqual([
      {
        id: task.id,
        title: "Task",
        type: "task",
        status: "open",
        priority: "P2",
        parentId: epic.id,
      },
    ]);
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
});
