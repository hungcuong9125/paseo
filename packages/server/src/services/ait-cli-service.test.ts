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
    await expect(service.listIssues({ cwd })).rejects.toMatchObject({
      code: "uninitialised",
    });
  });

  it("initialises a tracker and lists no issues", async () => {
    const result = await service.initTracker({ cwd });
    expect(result.initialised).toBe(true);

    const list = await service.listIssues({ cwd });
    expect(list).toEqual({ issues: [], hiddenCount: 0 });
  });

  it("creates, shows, and lists an issue", async () => {
    await service.initTracker({ cwd });

    const created = await service.createIssue({
      cwd,
      input: { title: "Fix the thing", priority: "P1" },
    });
    expect(created.title).toBe("Fix the thing");
    expect(created.priority).toBe("P1");
    expect(created.status).toBe("open");
    expect(created.type).toBe("task");
    expect(created.parentId).toBeNull();

    const shown = await service.showIssue({ cwd, issueId: created.id });
    expect(shown.title).toBe("Fix the thing");
    expect(shown.description).toBeNull();
    expect(shown.children).toEqual([]);
    expect(shown.blockedBy).toEqual([]);
    expect(shown.notes).toEqual([]);

    const list = await service.listIssues({ cwd });
    expect(list.issues).toEqual([created]);
  });

  it("keeps parentId correct across status mutations (update/close/reopen)", async () => {
    await service.initTracker({ cwd });

    const epic = await service.createIssue({ cwd, input: { title: "Epic", issueType: "epic" } });
    const task = await service.createIssue({
      cwd,
      input: { title: "Task under epic", parentId: epic.id },
    });
    expect(task.parentId).toBe(epic.id);

    const started = await service.updateIssue({
      cwd,
      issueId: task.id,
      input: { status: "in_progress" },
    });
    expect(started.status).toBe("in_progress");
    expect(started.parentId).toBe(epic.id);

    const closed = await service.closeIssue({ cwd, issueId: task.id });
    expect(closed.status).toBe("closed");
    expect(closed.parentId).toBe(epic.id);

    const reopened = await service.reopenIssue({ cwd, issueId: task.id });
    expect(reopened.status).toBe("open");
    expect(reopened.parentId).toBe(epic.id);

    const cancelled = await service.cancelIssue({ cwd, issueId: task.id });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.parentId).toBe(epic.id);
  });

  it("shows children on the parent after creating a child issue", async () => {
    await service.initTracker({ cwd });
    const epic = await service.createIssue({ cwd, input: { title: "Epic", issueType: "epic" } });
    const task = await service.createIssue({
      cwd,
      input: { title: "Task", parentId: epic.id },
    });

    const shown = await service.showIssue({ cwd, issueId: epic.id });
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

  it("excludes closed issues from the default list but includes them with all", async () => {
    await service.initTracker({ cwd });
    const issue = await service.createIssue({ cwd, input: { title: "Will be closed" } });
    await service.closeIssue({ cwd, issueId: issue.id });

    const openOnly = await service.listIssues({ cwd });
    expect(openOnly.issues).toEqual([]);
    expect(openOnly.hiddenCount).toBe(1);

    const all = await service.listIssues({ cwd, all: true });
    expect(all.issues.map((entry) => entry.id)).toEqual([issue.id]);
  });

  it("adds a note and reads it back through show", async () => {
    await service.initTracker({ cwd });
    const issue = await service.createIssue({ cwd, input: { title: "Needs a note" } });

    const note = await service.addNote({
      cwd,
      issueId: issue.id,
      body: "Investigated, root cause is X",
    });
    expect(note.body).toBe("Investigated, root cause is X");
    expect(note.id).toBeTruthy();
    expect(note.createdAt).toBeTruthy();

    const shown = await service.showIssue({ cwd, issueId: issue.id });
    expect(shown.notes).toEqual([note]);
  });

  it("rejects with not_found for a missing issue id", async () => {
    await service.initTracker({ cwd });
    await expect(service.showIssue({ cwd, issueId: "nope-00000" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects with cli_missing when ait is not on PATH", async () => {
    await service.initTracker({ cwd });
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const isolatedService = createAitService();
      await expect(isolatedService.listIssues({ cwd })).rejects.toMatchObject({
        code: "cli_missing",
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("throws AitCliError instances with a readable message", async () => {
    const error = await service.listIssues({ cwd }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AitCliError);
    expect((error as AitCliError).message.length).toBeGreaterThan(0);
  });
});
