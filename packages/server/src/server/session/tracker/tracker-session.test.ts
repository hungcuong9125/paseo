import { describe, expect, it } from "vitest";
import pino from "pino";
import { TrackerSession } from "./tracker-session.js";
import { createStub } from "../../test-utils/class-mocks.js";
import { findByType } from "../../test-utils/session-stubs.js";
import type { SessionOutboundMessage } from "../../messages.js";
import { AitCliError, type AitService } from "../../../services/ait-cli-service.js";
import type { ProjectRegistry } from "../../workspace-registry.js";
import type { TrackerSyncManager } from "../../tracker-sync-manager.js";

const PROJECT_ID = "prj_abc123";
const CWD = "/repo/my-project";

function makeSession(
  ait: { [K in keyof AitService]?: unknown },
  trackerSyncManager?: { [K in keyof TrackerSyncManager]?: unknown },
) {
  const emitted: SessionOutboundMessage[] = [];
  const projectRegistry = createStub<Pick<ProjectRegistry, "get">>({
    get: async (id: string) =>
      id === PROJECT_ID
        ? ({ projectId: PROJECT_ID, rootPath: CWD } as Awaited<ReturnType<ProjectRegistry["get"]>>)
        : null,
  });
  const session = new TrackerSession({
    host: { emit: (message) => emitted.push(message) },
    aitService: createStub<AitService>(ait),
    projectRegistry,
    logger: pino({ level: "silent" }),
    ...(trackerSyncManager
      ? { trackerSyncManager: createStub<TrackerSyncManager>(trackerSyncManager) }
      : {}),
  });
  return { session, emitted };
}

const SAMPLE_TRACKER = {
  id: "proj-1",
  title: "Fix the thing",
  type: "task" as const,
  status: "open" as const,
  priority: "P2" as const,
  parentId: null,
};

describe("TrackerSession", () => {
  it("resolves projectId to cwd before calling the ait service", async () => {
    let receivedCwd: string | undefined;
    const { session, emitted } = makeSession({
      listTrackers: async ({ cwd }: { cwd: string }) => {
        receivedCwd = cwd;
        return { trackers: [SAMPLE_TRACKER], hiddenCount: 0 };
      },
    });

    await session.handleProjectTrackerListRequest({
      type: "project.tracker.list.request",
      requestId: "r1",
      projectId: PROJECT_ID,
    });

    expect(receivedCwd).toBe(CWD);
    const response = findByType(emitted, "project.tracker.list.response");
    expect(response?.payload.trackers).toEqual([SAMPLE_TRACKER]);
    expect(response?.payload.error).toBeNull();
    expect(response?.payload.errorCode).toBeNull();
  });

  it("emits not_found when the projectId does not resolve", async () => {
    const { session, emitted } = makeSession({});

    await session.handleProjectTrackerListRequest({
      type: "project.tracker.list.request",
      requestId: "r2",
      projectId: "prj_does_not_exist",
    });

    const response = findByType(emitted, "project.tracker.list.response");
    expect(response?.payload.trackers).toEqual([]);
    expect(response?.payload.errorCode).toBe("not_found");
    expect(response?.payload.error).toContain("prj_does_not_exist");
  });

  it("preserves manager AIT errors in the legacy list response", async () => {
    const { session, emitted } = makeSession(
      {},
      {
        list: async () => ({
          trackers: [],
          hiddenCount: 0,
          epoch: 1,
          generation: 1,
          error: "no ait database",
          errorCode: "uninitialised",
        }),
      },
    );

    await session.handleProjectTrackerListRequest({
      type: "project.tracker.list.request",
      requestId: "r-list-error",
      projectId: PROJECT_ID,
    });

    const response = findByType(emitted, "project.tracker.list.response");
    expect(response?.payload).toMatchObject({
      trackers: [],
      hiddenCount: 0,
      error: "no ait database",
      errorCode: "uninitialised",
    });
  });

  it("maps an AitCliError's code and message onto the response payload", async () => {
    const { session, emitted } = makeSession({
      showTracker: async () => {
        throw new AitCliError("uninitialised", "no ait database — run 'ait init' first");
      },
    });

    await session.handleProjectTrackerShowRequest({
      type: "project.tracker.show.request",
      requestId: "r3",
      projectId: PROJECT_ID,
      trackerId: "proj-1",
    });

    const response = findByType(emitted, "project.tracker.show.response");
    expect(response?.payload.tracker).toBeNull();
    expect(response?.payload.errorCode).toBe("uninitialised");
    expect(response?.payload.error).toBe("no ait database — run 'ait init' first");
  });

  it("passes create fields through to the ait service", async () => {
    let received: unknown;
    const { session, emitted } = makeSession({
      createTracker: async (options: unknown) => {
        received = options;
        return SAMPLE_TRACKER;
      },
    });

    await session.handleProjectTrackerCreateRequest({
      type: "project.tracker.create.request",
      requestId: "r4",
      projectId: PROJECT_ID,
      title: "Fix the thing",
      trackerType: "task",
      priority: "P2",
    });

    expect(received).toEqual({
      cwd: CWD,
      input: {
        title: "Fix the thing",
        trackerType: "task",
        priority: "P2",
        parentId: undefined,
        description: undefined,
      },
    });
    const response = findByType(emitted, "project.tracker.create.response");
    expect(response?.payload.tracker).toEqual(SAMPLE_TRACKER);
  });

  it("close/reopen/cancel each call their matching ait service method and emit a summary", async () => {
    const closed = { ...SAMPLE_TRACKER, status: "closed" as const };
    const { session, emitted } = makeSession({
      closeTracker: async () => closed,
    });

    await session.handleProjectTrackerCloseRequest({
      type: "project.tracker.close.request",
      requestId: "r5",
      projectId: PROJECT_ID,
      trackerId: SAMPLE_TRACKER.id,
    });

    const response = findByType(emitted, "project.tracker.close.response");
    expect(response?.payload.tracker).toEqual(closed);
    expect(response?.payload.error).toBeNull();
  });

  it("delete calls deleteTracker with cascade and emits the deleted ids", async () => {
    let receivedCascade: boolean | undefined;
    const { session, emitted } = makeSession({
      deleteTracker: async ({ cascade }: { cascade?: boolean }) => {
        receivedCascade = cascade;
        return [SAMPLE_TRACKER.id, "proj-1.1"];
      },
    });

    await session.handleProjectTrackerDeleteRequest({
      type: "project.tracker.delete.request",
      requestId: "r5b",
      projectId: PROJECT_ID,
      trackerId: SAMPLE_TRACKER.id,
      cascade: true,
    });

    expect(receivedCascade).toBe(true);
    const response = findByType(emitted, "project.tracker.delete.response");
    expect(response?.payload.deletedIds).toEqual([SAMPLE_TRACKER.id, "proj-1.1"]);
    expect(response?.payload.error).toBeNull();
  });

  it("delete emits deletedIds: null alongside the error when deleteTracker rejects", async () => {
    const { session, emitted } = makeSession({
      deleteTracker: async () => {
        throw new AitCliError("validation", "issue has descendants; pass --cascade");
      },
    });

    await session.handleProjectTrackerDeleteRequest({
      type: "project.tracker.delete.request",
      requestId: "r5c",
      projectId: PROJECT_ID,
      trackerId: SAMPLE_TRACKER.id,
    });

    const response = findByType(emitted, "project.tracker.delete.response");
    expect(response?.payload.deletedIds).toBeNull();
    expect(response?.payload.errorCode).toBe("validation");
  });

  it("note_add emits the created note", async () => {
    const note = { id: "n1", body: "root cause found", createdAt: "2026-01-01T00:00:00Z" };
    const { session, emitted } = makeSession({
      addNote: async () => note,
    });

    await session.handleProjectTrackerNoteAddRequest({
      type: "project.tracker.note_add.request",
      requestId: "r6",
      projectId: PROJECT_ID,
      trackerId: SAMPLE_TRACKER.id,
      body: "root cause found",
    });

    const response = findByType(emitted, "project.tracker.note_add.response");
    expect(response?.payload.note).toEqual(note);
  });

  it("init emits initialised: false alongside the error when initTracker rejects", async () => {
    const { session, emitted } = makeSession({
      initTracker: async () => {
        throw new AitCliError("cli_missing", "The 'ait' CLI is not installed on this host.");
      },
    });

    await session.handleProjectTrackerInitRequest({
      type: "project.tracker.init.request",
      requestId: "r7",
      projectId: PROJECT_ID,
    });

    const response = findByType(emitted, "project.tracker.init.response");
    expect(response?.payload.initialised).toBe(false);
    expect(response?.payload.errorCode).toBe("cli_missing");
  });

  it("ready emits the ready id list from the ait service", async () => {
    const { session, emitted } = makeSession({
      listReadyIds: async () => ["proj-1", "proj-2"],
    });

    await session.handleProjectTrackerReadyRequest({
      type: "project.tracker.ready.request",
      requestId: "r8",
      projectId: PROJECT_ID,
    });

    const response = findByType(emitted, "project.tracker.ready.response");
    expect(response?.payload.readyIds).toEqual(["proj-1", "proj-2"]);
    expect(response?.payload.error).toBeNull();
    expect(response?.payload.errorCode).toBeNull();
  });

  it("ready emits not_found when the projectId does not resolve", async () => {
    const { session, emitted } = makeSession({});

    await session.handleProjectTrackerReadyRequest({
      type: "project.tracker.ready.request",
      requestId: "r9",
      projectId: "prj_does_not_exist",
    });

    const response = findByType(emitted, "project.tracker.ready.response");
    expect(response?.payload.readyIds).toEqual([]);
    expect(response?.payload.errorCode).toBe("not_found");
    expect(response?.payload.error).toContain("prj_does_not_exist");
  });

  it("ready maps a cli_missing AitCliError onto the response payload", async () => {
    const { session, emitted } = makeSession({
      listReadyIds: async () => {
        throw new AitCliError("cli_missing", "The 'ait' CLI is not installed on this host.");
      },
    });

    await session.handleProjectTrackerReadyRequest({
      type: "project.tracker.ready.request",
      requestId: "r10",
      projectId: PROJECT_ID,
    });

    const response = findByType(emitted, "project.tracker.ready.response");
    expect(response?.payload.readyIds).toEqual([]);
    expect(response?.payload.errorCode).toBe("cli_missing");
    expect(response?.payload.error).toBe("The 'ait' CLI is not installed on this host.");
  });
});
