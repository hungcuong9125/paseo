import { afterEach, describe, expect, it, vi } from "vitest";
import type { AitService } from "../services/ait-cli-service.js";
import type {
  FileObserver,
  FileObserverCallback,
  FileObserverSubscription,
} from "./file-observer/index.js";
import {
  getTrackerStatsCounts,
  TRACKER_ROOT_IDLE_TTL_MS,
  TrackerSyncManager,
  withTrackerSubtreeStats,
} from "./tracker-sync-manager.js";

const PROJECT_ID = "project-1";
const ROOT = "/tmp/project-1";
const TRACKER = {
  id: "task-1",
  title: "Keep tracker fresh",
  type: "task" as const,
  status: "open" as const,
  priority: "P2" as const,
  parentId: null,
};

function createHarness() {
  let callback: FileObserverCallback | null = null;
  let unsubscribeCount = 0;
  const observer: FileObserver = {
    async subscribe(_directory, next) {
      callback = next;
      const subscription: FileObserverSubscription = {
        updateIgnore: async () => {},
        unsubscribe: async () => {
          unsubscribeCount += 1;
          callback = null;
        },
      };
      return subscription;
    },
    getDiagnostics: () => ({
      activeObservationCount: 0,
      nativeHandleCount: 0,
      nativeTrackedFileCount: 0,
      pendingEventCount: 0,
      pendingReconciliationWorkCount: 0,
      reconciliationInFlightCount: 0,
      reconciliationCount: 0,
      scopedReconciliationCount: 0,
      fullReconciliationCount: 0,
      reconciliationFailureCount: 0,
      observerFailureCount: 0,
      directoryLimitFailureCount: 0,
      nativeEventCount: 0,
      nativeChangeEventCount: 0,
      nativeRenameEventCount: 0,
      nativePathlessEventCount: 0,
      nativeClassificationCount: 0,
      nativeShallowScanCount: 0,
      lastReconciliationDurationMs: 0,
      maxReconciliationDurationMs: 0,
    }),
    close: async () => {},
  };
  let listCalls = 0;
  const ait: AitService = {
    listTrackers: async () => {
      listCalls += 1;
      return { trackers: [TRACKER], hiddenCount: 2 };
    },
    showTracker: async () => {
      throw new Error("unused");
    },
    createTracker: async () => TRACKER,
    updateTracker: async () => TRACKER,
    closeTracker: async () => TRACKER,
    reopenTracker: async () => TRACKER,
    cancelTracker: async () => TRACKER,
    addNote: async () => ({ id: "note", body: "note", createdAt: "now" }),
    initTracker: async () => ({ initialised: true }),
  };
  const projectRegistry = {
    get: async (projectId: string) =>
      projectId === PROJECT_ID ? ({ projectId, rootPath: ROOT, archivedAt: null } as const) : null,
  };
  const manager = new TrackerSyncManager({
    aitService: ait,
    projectRegistry,
    fileObserver: observer,
    directoryExists: async () => true,
  });
  return {
    manager,
    get listCalls() {
      return listCalls;
    },
    emitChange: () => callback?.(null, [{ path: `${ROOT}/.ait/ait.db`, type: "update" }]),
    get unsubscribeCount() {
      return unsubscribeCount;
    },
  };
}

describe("TrackerSyncManager", () => {
  afterEach(() => vi.useRealTimers());

  it("counts every status in the type and priority buckets", () => {
    const counts = getTrackerStatsCounts([
      { ...TRACKER, id: "open-p0", priority: "P0", status: "open" },
      { ...TRACKER, id: "closed-p0", priority: "P0", status: "closed" },
      { ...TRACKER, id: "cancelled-p1", priority: "P1", status: "cancelled" },
      {
        ...TRACKER,
        id: "initiative-p1",
        type: "initiative",
        priority: "P1",
        status: "in_progress",
      },
    ]);

    expect(counts.all).toEqual({
      total: 4,
      byStatus: { open: 1, in_progress: 1, closed: 1, cancelled: 1 },
      byPriority: { P0: 2, P1: 2, P2: 0, P3: 0, P4: 0 },
    });
    expect(counts.task.total).toBe(3);
    expect(counts.initiative.byPriority).toEqual({ P0: 0, P1: 1, P2: 0, P3: 0, P4: 0 });
  });

  it("guards subtree counts against parent cycles", () => {
    const cycle = [
      { ...TRACKER, id: "cycle-a", parentId: "cycle-b" },
      { ...TRACKER, id: "cycle-b", parentId: "cycle-a", status: "cancelled" as const },
    ];

    expect(withTrackerSubtreeStats([cycle[0]], cycle)[0]).toMatchObject({
      childCount: 2,
      doneCount: 1,
    });
  });

  it("stops subtree counts at the shared maximum depth", () => {
    const chain = Array.from({ length: 34 }, (_, index) => ({
      ...TRACKER,
      id: `chain-${index}`,
      parentId: index === 0 ? null : `chain-${index - 1}`,
      status: index === 33 ? ("closed" as const) : ("open" as const),
    }));

    expect(withTrackerSubtreeStats([chain[0]], chain)[0]).toMatchObject({
      childCount: 32,
      doneCount: 0,
    });
  });

  it("shares one initial snapshot and one variant refresh between listeners", async () => {
    const harness = createHarness();
    const updates: string[] = [];
    const first = await harness.manager.subscribe({
      projectId: PROJECT_ID,
      subscriptionId: "sub-1",
      listener: (_snapshot, projectId) => updates.push(`sub-1:${projectId}`),
    });
    const second = await harness.manager.subscribe({
      projectId: PROJECT_ID,
      subscriptionId: "sub-2",
      listener: (_snapshot, projectId) => updates.push(`sub-2:${projectId}`),
    });

    expect(first.trackers).toEqual([TRACKER]);
    expect(second.epoch).toBe(first.epoch);
    expect(second.generation).toBe(first.generation);
    expect(harness.listCalls).toBe(1);

    await harness.manager.requestRefresh(ROOT);
    expect(harness.listCalls).toBe(2);
    expect(updates).toEqual([]);

    await harness.manager.unsubscribe("sub-1");
    await harness.manager.unsubscribe("sub-2");
    await harness.manager.close();
    expect(harness.unsubscribeCount).toBe(1);
  });

  it("returns a warm full snapshot without spawning ait again", async () => {
    const harness = createHarness();
    await harness.manager.subscribe({
      projectId: PROJECT_ID,
      all: true,
      subscriptionId: "warm",
      listener: () => {},
    });

    const snapshot = await harness.manager.getSnapshot(PROJECT_ID, true);

    expect(snapshot.trackers).toEqual([TRACKER]);
    expect(harness.listCalls).toBe(1);
    await harness.manager.close();
  });

  it("shares consecutive snapshot reads without a listener during the idle TTL", async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    await harness.manager.getSnapshot(PROJECT_ID, true);
    await harness.manager.getSnapshot(PROJECT_ID, true);

    expect(harness.listCalls).toBe(1);
    await harness.manager.close();
  });

  it("refreshes an idle snapshot after a file-observer event", async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    await harness.manager.getSnapshot(PROJECT_ID, true);
    harness.emitChange();
    await vi.advanceTimersByTimeAsync(150);
    await harness.manager.getSnapshot(PROJECT_ID, true);

    expect(harness.listCalls).toBe(2);
    await harness.manager.close();
  });

  it("disposes an idle root when its TTL elapses", async () => {
    vi.useFakeTimers();
    const harness = createHarness();

    await harness.manager.getSnapshot(PROJECT_ID, true);
    await vi.advanceTimersByTimeAsync(TRACKER_ROOT_IDLE_TTL_MS);

    expect(harness.unsubscribeCount).toBe(1);
    await harness.manager.close();
  });

  it("routes all variants through the same root observer", async () => {
    const harness = createHarness();
    const normal = await harness.manager.subscribe({
      projectId: PROJECT_ID,
      subscriptionId: "normal",
      listener: () => {},
    });
    const all = await harness.manager.subscribe({
      projectId: PROJECT_ID,
      all: true,
      subscriptionId: "all",
      listener: () => {},
    });
    expect(all.epoch).not.toBe(normal.epoch);
    expect(harness.listCalls).toBe(2);
    await harness.manager.close();
    expect(harness.unsubscribeCount).toBe(1);
  });

  it("rejects a missing project without attaching an observer", async () => {
    const harness = createHarness();
    await expect(
      harness.manager.subscribe({
        projectId: "missing",
        subscriptionId: "sub",
        listener: () => {},
      }),
    ).rejects.toMatchObject({ trackerErrorCode: "not_found" });
    expect(harness.listCalls).toBe(0);
  });
});
