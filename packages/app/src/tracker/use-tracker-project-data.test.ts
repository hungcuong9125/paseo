/**
 * @vitest-environment jsdom
 */
import React, { useEffect, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { Pressable } from "react-native";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackerStatus, TrackerSummary } from "@getpaseo/protocol/tracker/types";
import type { AggregatedTracker, TrackerProjectInput } from "@/tracker/aggregated-trackers";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";

const { runtimeState, connectionStatusState } = vi.hoisted(() => ({
  runtimeState: {
    getClient: vi.fn(),
    getSnapshot: vi.fn((serverId: string) => ({
      connectionStatus: connectionStatusState.byServer[serverId] ?? "online",
    })),
  },
  connectionStatusState: {
    byServer: {} as Record<string, string>,
    listeners: new Set<() => void>(),
  },
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => runtimeState,
  // Minimal reactive stand-in for the real useSyncExternalStore-backed hook —
  // re-renders the calling component whenever setConnectionStatus below
  // fires, mirroring the reactivity useTrackerProjectData's connectionStatusKey
  // relies on (pas-2KY5X.13's fix), the same shape use-tracker-stats.test.ts
  // uses for useSessionStore (pas-2KY5X.1).
  useHostRuntimeConnectionStatuses: (
    serverIds: readonly string[],
  ): ReadonlyMap<string, HostRuntimeConnectionStatus> => {
    const [, forceRender] = useReducer((c: number) => c + 1, 0);
    useEffect(() => {
      const listener = () => forceRender();
      connectionStatusState.listeners.add(listener);
      return () => {
        connectionStatusState.listeners.delete(listener);
      };
    }, []);
    return new Map(
      serverIds.map((serverId) => [
        serverId,
        (connectionStatusState.byServer[serverId] ?? "online") as HostRuntimeConnectionStatus,
      ]),
    );
  },
}));

function setConnectionStatus(serverId: string, status: HostRuntimeConnectionStatus): void {
  connectionStatusState.byServer = { ...connectionStatusState.byServer, [serverId]: status };
  for (const listener of connectionStatusState.listeners) {
    listener();
  }
}

import { useTrackerProjectData } from "./use-tracker-project-data";

// vitest.config.ts doesn't set `globals: true`, so @testing-library/react's
// own auto-cleanup (which detects a global `afterEach`) never engages here —
// every renderHook() in this file stayed mounted for the rest of the run
// without this. That's normally harmless (a stale hook with nothing left to
// do), but connectionStatusState.listeners (module-level, shared by every
// test via the mocked useHostRuntimeConnectionStatuses above) is never
// pruned without unmounting, so a later test's setConnectionStatus call
// notifies every earlier test's still-registered listener too — each one
// forces its long-dead component to re-render against the CURRENT test's
// runtime mocks, and if that stale render fires a fetch, it pollutes the
// current test's shared call-count assertions (pas-2KY5X.25 caught this via
// a merge-mode row count that only came out wrong running the full suite,
// never in isolation). cleanup() unmounts every rendered tree, which runs
// each effect's own teardown — including the listener's removal above.
afterEach(() => {
  cleanup();
});

const PROJECT_A: TrackerProjectInput = {
  serverId: "host-a",
  serverName: "Host A",
  projectId: "prj-a",
  projectName: "Project A",
  projectRootPath: "/repo/prj-a",
};
const PROJECT_B: TrackerProjectInput = {
  serverId: "host-a",
  serverName: "Host A",
  projectId: "prj-b",
  projectName: "Project B",
  projectRootPath: "/repo/prj-b",
};
const PROJECT_C: TrackerProjectInput = {
  serverId: "host-b",
  serverName: "Host B",
  projectId: "prj-c",
  projectName: "Project C",
  projectRootPath: "/repo/prj-c",
};

function makeTracker(id: string, status: TrackerStatus = "open"): TrackerSummary {
  return {
    id,
    title: `Tracker ${id}`,
    type: "task",
    status,
    priority: "P2",
    parentId: null,
  };
}

/** Full AggregatedTracker row, PROJECT_A-tagged — lets pas-2KY5X.11 tests set
 * `parentId`/`childCount`/`doneCount` directly, which makeTracker doesn't expose. */
function trackerRow(overrides: Partial<AggregatedTracker> & { id: string }): AggregatedTracker {
  return {
    title: `Tracker ${overrides.id}`,
    type: "task",
    status: "open",
    priority: "P2",
    parentId: null,
    ...PROJECT_A,
    ...overrides,
  };
}

interface ListResponse {
  trackers: TrackerSummary[];
  hiddenCount: number;
  pageInfo?: { nextCursor: string | null; hasMore: boolean; totalCount?: number };
}

const EMPTY_PAGE: ListResponse = {
  trackers: [],
  hiddenCount: 0,
  pageInfo: { nextCursor: null, hasMore: false },
};

/** Installs a `trackerList` mock driven by a per-(projectId, status, cursor) response table.
 * Returns the mock so tests can assert on which pages were actually requested. */
function installClient(
  responses: Record<string, ListResponse | (() => Promise<ListResponse>)>,
): ReturnType<typeof vi.fn> {
  const trackerList = vi.fn(
    async (args: { projectId: string; status?: TrackerStatus; page?: { cursor?: string } }) => {
      const key = `${args.projectId}:${args.status}:${args.page?.cursor ?? "start"}`;
      const entry = responses[key] ?? EMPTY_PAGE;
      return typeof entry === "function" ? entry() : entry;
    },
  );
  runtimeState.getClient.mockReturnValue({
    trackerList,
    trackerSearch: vi.fn(),
    // Defaults every test onto the per-project path (aitTrackerSort
    // unsupported) unless a test explicitly overrides this — see
    // installGenerousSortedClient for pas-2KY5X.15's merge-mode tests.
    getLastServerInfoMessage: () => ({ features: { aitTrackerSort: false } }),
  });
  return trackerList;
}

/**
 * A trackerList mock standing in for a real, generously-stocked ait project:
 * every call returns exactly `limit` items (or fewer once that
 * project+status's configured supply runs out), newest-first via a single
 * clock shared across every project so createdAt stays globally consistent
 * no matter which project's call happens to resolve first — the same
 * guarantee a real merge of independently-sorted streams relies on.
 * Advertises `aitTrackerSort: true`, so useTrackerProjectData takes the
 * merge path (pas-2KY5X.15). Returns the trackerList mock plus a
 * `fetchedRowCounts` log (recorded synchronously, unlike `mock.results` —
 * an async mock's captured "value" is the pending Promise, not its
 * resolution) so tests can measure exactly how many rows each request
 * actually served.
 */
function installGenerousSortedClient(supplyByProjectId: Record<string, number>): {
  trackerList: ReturnType<typeof vi.fn>;
  fetchedRowCounts: { projectId: string; status: TrackerStatus | undefined; count: number }[];
} {
  let clock = 1_000_000;
  const remainingByKey = new Map<string, number>();
  const fetchedRowCounts: {
    projectId: string;
    status: TrackerStatus | undefined;
    count: number;
  }[] = [];
  const trackerList = vi.fn(
    async (args: {
      projectId: string;
      status?: TrackerStatus;
      page?: { limit: number; cursor?: string };
    }) => {
      const key = `${args.projectId}:${args.status}`;
      const total = supplyByProjectId[args.projectId] ?? 0;
      const remaining = remainingByKey.get(key) ?? total;
      const limit = args.page?.limit ?? total;
      const take = Math.max(0, Math.min(remaining, limit));
      fetchedRowCounts.push({ projectId: args.projectId, status: args.status, count: take });
      const trackers: TrackerSummary[] = [];
      for (let i = 0; i < take; i++) {
        clock -= 1;
        trackers.push({
          id: `${args.projectId}-${clock}`,
          title: `Tracker ${clock}`,
          type: "task",
          status: args.status ?? "open",
          priority: "P2",
          parentId: null,
          createdAt: String(clock).padStart(10, "0"),
        });
      }
      const nextRemaining = remaining - take;
      remainingByKey.set(key, nextRemaining);
      return {
        trackers,
        hiddenCount: 0,
        pageInfo: {
          nextCursor: nextRemaining > 0 ? `cursor-${nextRemaining}` : null,
          hasMore: nextRemaining > 0,
          totalCount: total,
        },
      };
    },
  );
  runtimeState.getClient.mockReturnValue({
    trackerList,
    trackerSearch: vi.fn(),
    getLastServerInfoMessage: () => ({ features: { aitTrackerSort: true } }),
  });
  return { trackerList, fetchedRowCounts };
}

describe("useTrackerProjectData", () => {
  beforeEach(() => {
    connectionStatusState.byServer = {};
  });

  it("loads exactly the first page of every section on mount, with no automatic follow-up fetch", async () => {
    const trackerList = installClient({
      "prj-a:open:start": {
        trackers: [makeTracker("a-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: "1", hasMore: true },
      },
      "prj-a:open:1": {
        trackers: [makeTracker("a-open-2")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false },
      },
    });

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 1,
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.trackers.map((t) => t.id)).toEqual(["a-open-1"]);
    expect(result.current.sectionHasMore.open).toBe(true);

    // One request per (project, status) pair — never a follow-up for the
    // second `open` page that's still available.
    const openRequests = trackerList.mock.calls.filter(([args]) => args.status === "open");
    expect(openRequests).toHaveLength(1);

    // Give any accidental background fetch a chance to fire before asserting
    // it never did.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.trackers.map((t) => t.id)).toEqual(["a-open-1"]);
  });

  it("loadMore(status) advances every in-scope project by exactly one page for that status", async () => {
    const trackerList = installClient({
      "prj-a:open:start": {
        trackers: [makeTracker("a-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: "1", hasMore: true },
      },
      "prj-a:open:1": {
        trackers: [makeTracker("a-open-2")],
        hiddenCount: 0,
        pageInfo: { nextCursor: "2", hasMore: true },
      },
      "prj-b:open:start": {
        trackers: [makeTracker("b-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false },
      },
    });

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A, PROJECT_B],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 1,
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.trackers.map((t) => t.id).sort()).toEqual(["a-open-1", "b-open-1"]);

    act(() => {
      result.current.loadMore("open");
    });
    expect(result.current.sectionLoadingMore.open).toBe(true);

    await waitFor(() => expect(result.current.sectionLoadingMore.open).toBe(false));
    expect(result.current.trackers.map((t) => t.id).sort()).toEqual([
      "a-open-1",
      "a-open-2",
      "b-open-1",
    ]);
    // prj-a still has more (nextCursor "2"); prj-b never had more.
    expect(result.current.sectionHasMore.open).toBe(true);

    // Only one `open` page requested beyond the first for prj-a; prj-b was
    // not re-requested since its first `open` page already reported
    // hasMore: false. (Each project also received one request per other
    // status on mount, which this filter excludes.)
    const prjAOpenRequests = trackerList.mock.calls.filter(
      ([args]) => args.projectId === "prj-a" && args.status === "open",
    );
    const prjBOpenRequests = trackerList.mock.calls.filter(
      ([args]) => args.projectId === "prj-b" && args.status === "open",
    );
    expect(prjAOpenRequests).toHaveLength(2);
    expect(prjBOpenRequests).toHaveLength(1);
  });

  it("a real press on the Show More button, the instant it lands in the DOM, fetches page 2 on the first click (pas-2KY5X.16)", async () => {
    // Reproduces the reported "Show more needs two clicks" bug. This has to
    // render a real Pressable and dispatch a real DOM click with NO act()
    // wrapping around the resolve/poll/click sequence — renderHook's own
    // result.current accessor turned out to force a synchronous act()-style
    // flush that masked the race entirely (verified: a renderHook + `await
    // act(async () => { resolve(); await Promise.resolve(); result.current.
    // loadMore(...) })` version of this test passed identically on the
    // pre-fix code, because act() had already flushed the effect by the time
    // loadMore ran — a false-negative that would have shipped this bug
    // uncaught). Only a bare createRoot().render() + a raw
    // element.dispatchEvent(), matching how the real app actually receives a
    // click, reproduces it: on the pre-fix code (sectionsRef synced via a
    // useEffect) this asserts exactly 1 request — the click landed before the
    // effect flushed, read pre-merge cursors, found no targets, and silently
    // did nothing; a second, later press worked because the effect had had
    // more time to catch up by then.
    let resolveOpenPage: (value: unknown) => void = () => {};
    const openPagePromise = new Promise((resolve) => {
      resolveOpenPage = resolve;
    });
    const trackerList = vi.fn(
      async (args: { status?: TrackerStatus; page?: { cursor?: string } }) => {
        if (args.status === "open" && args.page?.cursor === undefined) {
          return openPagePromise;
        }
        return { trackers: [], hiddenCount: 0, pageInfo: { nextCursor: null, hasMore: false } };
      },
    );
    runtimeState.getClient.mockReturnValue({
      trackerList,
      trackerSearch: vi.fn(),
      // Defaults every test onto the per-project path (aitTrackerSort
      // unsupported) unless a test explicitly overrides this — see
      // installGenerousSortedClient for pas-2KY5X.15's merge-mode tests.
      getLastServerInfoMessage: () => ({ features: { aitTrackerSort: false } }),
    });

    function ShowMoreHarness() {
      const data = useTrackerProjectData({
        projects: [PROJECT_A],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 1,
      });
      return data.sectionHasMore.open
        ? React.createElement(Pressable, {
            testID: "show-more",
            onPress: () => data.loadMore("open"),
          })
        : null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => {
        root.render(React.createElement(ShowMoreHarness));
      });

      resolveOpenPage({
        trackers: [makeTracker("a-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: "1", hasMore: true },
      });

      let button: HTMLElement | null = null;
      for (let i = 0; i < 50 && !button; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        button = container.querySelector('[data-testid="show-more"]');
      }
      if (!button) {
        throw new Error("Expected the Show More button to appear");
      }
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

      await new Promise((resolve) => setTimeout(resolve, 0));
      const openRequests = trackerList.mock.calls.filter(
        (call) => (call[0] as { status?: TrackerStatus }).status === "open",
      );
      expect(openRequests).toHaveLength(2);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it("sectionTotals sums pageInfo.totalCount across in-scope projects, and goes null when any project omits it", async () => {
    installClient({
      "prj-a:open:start": {
        trackers: [makeTracker("a-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 5 },
      },
      "prj-b:open:start": {
        trackers: [makeTracker("b-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 3 },
      },
    });

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A, PROJECT_B],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.sectionTotals.open).toBe(8);

    // Reinstall without a totalCount for prj-b, and force a fresh load —
    // the summed total must go null rather than silently undercount.
    installClient({
      "prj-a:open:start": {
        trackers: [makeTracker("a-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 5 },
      },
      "prj-b:open:start": {
        trackers: [makeTracker("b-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false },
      },
    });
    act(() => {
      result.current.refetch();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.sectionTotals.open).toBe(null);
  });

  it("discards a stale loadMore page instead of merging it after the scope changes mid-fetch", async () => {
    let resolveStalePage: ((value: ListResponse) => void) | null = null;
    const stalePagePromise = new Promise<ListResponse>((resolve) => {
      resolveStalePage = resolve;
    });

    installClient({
      "prj-a:open:start": {
        trackers: [makeTracker("a-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: "1", hasMore: true },
      },
      // Held open until the test resolves it below, simulating a loadMore
      // fetch still in flight when the scope changes.
      "prj-a:open:1": () => stalePagePromise,
      "prj-b:open:start": {
        trackers: [makeTracker("b-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false },
      },
    });

    const { result, rerender } = renderHook(
      ({ selectedProjectId }: { selectedProjectId: string | null }) =>
        useTrackerProjectData({
          projects: [PROJECT_A, PROJECT_B],
          selectedProjectId,
          all: true,
          enabled: true,
          pageSize: 1,
        }),
      { initialProps: { selectedProjectId: "prj-a" } },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.trackers.map((t) => t.id)).toEqual(["a-open-1"]);

    act(() => {
      result.current.loadMore("open");
    });
    expect(result.current.sectionLoadingMore.open).toBe(true);

    // Scope change while that loadMore fetch is still pending — this must
    // bump the hook's internal sequence so the eventually-resolving stale
    // page is rejected rather than merged into prj-b's data.
    rerender({ selectedProjectId: "prj-b" });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.trackers.map((t) => t.id)).toEqual(["b-open-1"]);
    // The new scope's loadFirstPages must not inherit a stuck spinner from
    // the old scope's still-in-flight loadMore.
    expect(result.current.sectionLoadingMore.open).toBe(false);

    // Now let the stale prj-a fetch resolve — its result must never reach
    // the current (prj-b) state, and it must not re-flip the spinner back on.
    await act(async () => {
      resolveStalePage?.({
        trackers: [makeTracker("a-open-2")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.trackers.map((t) => t.id)).toEqual(["b-open-1"]);
    expect(result.current.sectionLoadingMore.open).toBe(false);
  });

  it("patchTracker replaces a tracker in place and re-files it under a changed status", async () => {
    installClient({});
    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.trackers).toEqual([]);

    act(() => {
      result.current.patchTracker({ ...makeTracker("new-1"), ...PROJECT_A });
    });
    expect(result.current.trackers.map((t) => t.id)).toEqual(["new-1"]);

    act(() => {
      result.current.patchTracker({ ...makeTracker("new-1", "closed"), ...PROJECT_A });
    });
    expect(result.current.trackers).toHaveLength(1);
    expect(result.current.trackers[0]?.status).toBe("closed");
  });

  it("patchTracker moving a tracker across statuses decrements the old section's total and increments the new one", async () => {
    installClient({
      "prj-a:open:start": {
        trackers: [makeTracker("a-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 5 },
      },
      "prj-a:closed:start": {
        trackers: [],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 2 },
      },
    });
    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.sectionTotals.open).toBe(5);
    expect(result.current.sectionTotals.closed).toBe(2);

    act(() => {
      result.current.patchTracker({ ...makeTracker("a-open-1", "closed"), ...PROJECT_A });
    });
    expect(result.current.sectionTotals.open).toBe(4);
    expect(result.current.sectionTotals.closed).toBe(3);

    // An in-place edit that doesn't change status must not move either total.
    act(() => {
      result.current.patchTracker({ ...makeTracker("a-open-1", "closed"), ...PROJECT_A });
    });
    expect(result.current.sectionTotals.open).toBe(4);
    expect(result.current.sectionTotals.closed).toBe(3);
  });

  it("patchTracker bumps every loaded ancestor's doneCount (not childCount) when a descendant's done-state flips (pas-2KY5X.11)", async () => {
    installClient({
      "prj-a:open:start": {
        trackers: [
          trackerRow({ id: "gp-1", parentId: null, childCount: 3, doneCount: 1 }),
          trackerRow({ id: "p-1", parentId: "gp-1", childCount: 1, doneCount: 0 }),
          trackerRow({ id: "c-1", parentId: "p-1", childCount: 0, doneCount: 0 }),
        ],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false },
      },
    });
    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.patchTracker(
        trackerRow({ id: "c-1", parentId: "p-1", status: "closed", childCount: 0, doneCount: 0 }),
      );
    });

    const byId = (id: string) => result.current.trackers.find((t) => t.id === id);
    // Both ancestors' doneCount advance by the same +1 — descendantStats
    // aggregates the whole subtree, not just direct children.
    expect(byId("p-1")?.doneCount).toBe(1);
    expect(byId("gp-1")?.doneCount).toBe(2);
    // No tree-shape change, so childCount is untouched on both.
    expect(byId("p-1")?.childCount).toBe(1);
    expect(byId("gp-1")?.childCount).toBe(3);
    expect(byId("c-1")?.status).toBe("closed");
  });

  it("patchTracker bumps every loaded ancestor's childCount (not doneCount) when a brand-new tracker is created under them (pas-2KY5X.11)", async () => {
    installClient({
      "prj-a:open:start": {
        trackers: [trackerRow({ id: "p-1", parentId: null, childCount: 1, doneCount: 0 })],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false },
      },
    });
    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.patchTracker(trackerRow({ id: "c-2", parentId: "p-1" }));
    });

    const parent = result.current.trackers.find((t) => t.id === "p-1");
    expect(parent?.childCount).toBe(2);
    expect(parent?.doneCount).toBe(0);
  });

  it("patchTracker leaves counts alone when the mutated tracker's parent isn't currently loaded", async () => {
    installClient({
      "prj-a:open:start": {
        trackers: [
          trackerRow({ id: "c-1", parentId: "missing-parent", childCount: 0, doneCount: 0 }),
        ],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false },
      },
    });
    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Must not throw for an ancestor the client never loaded — best effort,
    // not a crash.
    act(() => {
      result.current.patchTracker(
        trackerRow({
          id: "c-1",
          parentId: "missing-parent",
          status: "closed",
          childCount: 0,
          doneCount: 0,
        }),
      );
    });
    expect(result.current.trackers.map((t) => ({ id: t.id, status: t.status }))).toEqual([
      { id: "c-1", status: "closed" },
    ]);
  });

  it("patchTracker does not adjust ancestor counts across a reparent — no UI path sets it today, and guessing risks a wrong count", async () => {
    installClient({
      "prj-a:open:start": {
        trackers: [
          trackerRow({ id: "old-parent", parentId: null, childCount: 1, doneCount: 0 }),
          trackerRow({ id: "new-parent", parentId: null, childCount: 0, doneCount: 0 }),
          trackerRow({ id: "c-1", parentId: "old-parent", childCount: 0, doneCount: 0 }),
        ],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false },
      },
    });
    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.patchTracker(
        trackerRow({
          id: "c-1",
          parentId: "new-parent",
          status: "closed",
          childCount: 0,
          doneCount: 0,
        }),
      );
    });

    const byId = (id: string) => result.current.trackers.find((t) => t.id === id);
    expect(byId("old-parent")?.childCount).toBe(1);
    expect(byId("old-parent")?.doneCount).toBe(0);
    expect(byId("new-parent")?.childCount).toBe(0);
    expect(byId("new-parent")?.doneCount).toBe(0);
    expect(byId("c-1")?.parentId).toBe("new-parent");
  });

  it("removeTrackers drops trackers by id from wherever they live", async () => {
    installClient({
      "prj-a:open:start": {
        trackers: [makeTracker("a-1"), makeTracker("a-2")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false },
      },
    });
    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.trackers).toHaveLength(2);

    act(() => {
      result.current.removeTrackers(["a-1"]);
    });
    expect(result.current.trackers.map((t) => t.id)).toEqual(["a-2"]);
  });

  it("removeTrackers decrements the removed tracker's section total", async () => {
    installClient({
      "prj-a:open:start": {
        trackers: [makeTracker("a-1"), makeTracker("a-2")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 2 },
      },
    });
    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.sectionTotals.open).toBe(2);

    act(() => {
      result.current.removeTrackers(["a-1"]);
    });
    expect(result.current.sectionTotals.open).toBe(1);
  });

  it("removeTrackers decrements the parent's childCount (and doneCount if the removed child was done) (pas-2KY5X.11)", async () => {
    installClient({
      "prj-a:open:start": {
        trackers: [
          trackerRow({ id: "p-1", parentId: null, childCount: 2, doneCount: 1 }),
          trackerRow({ id: "c-1", parentId: "p-1", status: "closed", childCount: 0, doneCount: 0 }),
          trackerRow({ id: "c-2", parentId: "p-1", childCount: 0, doneCount: 0 }),
        ],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false },
      },
    });
    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // c-1 is closed (done) — removing it must pull both counts down.
    act(() => {
      result.current.removeTrackers(["c-1"]);
    });
    const parentAfterFirstDelete = result.current.trackers.find((t) => t.id === "p-1");
    expect(parentAfterFirstDelete?.childCount).toBe(1);
    expect(parentAfterFirstDelete?.doneCount).toBe(0);

    // c-2 is open (not done) — removing it drops childCount only.
    act(() => {
      result.current.removeTrackers(["c-2"]);
    });
    const parentAfterSecondDelete = result.current.trackers.find((t) => t.id === "p-1");
    expect(parentAfterSecondDelete?.childCount).toBe(0);
    expect(parentAfterSecondDelete?.doneCount).toBe(0);
  });

  it("removeTrackers on a delete-tree cascade decrements the grandparent once per removed descendant, even though the parent between them is removed too (pas-2KY5X.11)", async () => {
    installClient({
      "prj-a:open:start": {
        trackers: [
          trackerRow({ id: "gp-1", parentId: null, childCount: 2, doneCount: 0 }),
          trackerRow({ id: "p-1", parentId: "gp-1", childCount: 1, doneCount: 0 }),
          trackerRow({ id: "c-1", parentId: "p-1", childCount: 0, doneCount: 0 }),
        ],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false },
      },
    });
    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // A cascade removes p-1 and c-1 together — the server's real delete-tree
    // response shape (packages/app/screens/tracker-screen.tsx's trackerDelete
    // call passes the full removedIds list, not one id at a time).
    act(() => {
      result.current.removeTrackers(["p-1", "c-1"]);
    });

    expect(result.current.trackers.map((t) => t.id)).toEqual(["gp-1"]);
    // gp-1 loses both p-1 and c-1 from its subtree — 2, not 1 — even though
    // p-1 (the intermediate hop between gp-1 and c-1) was removed in the
    // same batch and never got its own row updated.
    expect(result.current.trackers[0]?.childCount).toBe(0);
  });

  it("leaves a null sectionTotal null through both patchTracker and removeTrackers", async () => {
    installClient({
      // No totalCount reported — sectionTotals.open must start (and stay) null.
      "prj-a:open:start": {
        trackers: [makeTracker("a-1"), makeTracker("a-2")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false },
      },
      "prj-a:closed:start": EMPTY_PAGE,
    });
    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.sectionTotals.open).toBe(null);

    act(() => {
      result.current.patchTracker({ ...makeTracker("a-1", "closed"), ...PROJECT_A });
    });
    expect(result.current.sectionTotals.open).toBe(null);
    expect(result.current.sectionTotals.closed).toBe(null);

    act(() => {
      result.current.removeTrackers(["a-2"]);
    });
    // "open" now has zero of prj-a's rows left (a-1 moved to "closed" above,
    // a-2 just removed) — sectionTotals (pas-2KY5X.25) no longer poisons a
    // project with an unknown total once it has no visible rows left to
    // hide, since summing 0 for it can't undercount below the (also zero)
    // row count on screen. Renders identically to the pre-fix null, which
    // fell back to the same zero via `trackers.length`.
    expect(result.current.sectionTotals.open).toBe(0);
  });

  it("changing the type filter reloads first pages instead of appending to the previous filter's results", async () => {
    const trackerList = vi.fn(
      async (args: {
        projectId: string;
        status?: TrackerStatus;
        trackerType?: string;
        page?: { cursor?: string };
      }) => {
        if (args.trackerType === "epic") {
          return {
            trackers:
              args.status === "open" ? [{ ...makeTracker("a-epic-1"), type: "epic" as const }] : [],
            hiddenCount: 0,
            pageInfo: {
              nextCursor: null,
              hasMore: false,
              totalCount: args.status === "open" ? 1 : 0,
            },
          };
        }
        return {
          trackers: args.status === "open" ? [makeTracker("a-task-1")] : [],
          hiddenCount: 0,
          pageInfo: {
            nextCursor: null,
            hasMore: false,
            totalCount: args.status === "open" ? 1 : 0,
          },
        };
      },
    );
    runtimeState.getClient.mockReturnValue({
      trackerList,
      trackerSearch: vi.fn(),
      // Defaults every test onto the per-project path (aitTrackerSort
      // unsupported) unless a test explicitly overrides this — see
      // installGenerousSortedClient for pas-2KY5X.15's merge-mode tests.
      getLastServerInfoMessage: () => ({ features: { aitTrackerSort: false } }),
    });

    const { result, rerender } = renderHook(
      ({ type }: { type: "task" | "epic" }) =>
        useTrackerProjectData({
          projects: [PROJECT_A],
          selectedProjectId: null,
          all: true,
          enabled: true,
          pageSize: 50,
          type,
        }),
      { initialProps: { type: "task" } },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.trackers.map((t) => t.id)).toEqual(["a-task-1"]);
    expect(result.current.sectionTotals.open).toBe(1);

    rerender({ type: "epic" });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // A fresh first-page load replaced the set entirely — the old filter's
    // rows are gone, not merged alongside the new ones.
    expect(result.current.trackers.map((t) => t.id)).toEqual(["a-epic-1"]);
    expect(result.current.sectionTotals.open).toBe(1);

    const epicCalls = trackerList.mock.calls.filter(([args]) => args.trackerType === "epic");
    expect(epicCalls.length).toBeGreaterThan(0);
    for (const [args] of epicCalls) {
      expect(args.page?.cursor).toBeUndefined();
    }
  });

  it("options.sections narrows which statuses are fetched, leaving the rest unfetched (pas-2KY5X.4)", async () => {
    const trackerList = installClient({
      "prj-a:open:start": {
        trackers: [makeTracker("a-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 1 },
      },
    });
    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
        sections: ["open"],
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.trackers.map((t) => t.id)).toEqual(["a-open-1"]);
    // The other three statuses were never requested at all, so no project
    // has a cursorState for them — sectionTotals (pas-2KY5X.25) treats that
    // the same as "hasn't answered yet" and sums to 0 rather than poisoning
    // to null; tracker-table.tsx's `total ?? items.length` renders the same
    // "0" either way here since zero rows are loaded for them regardless.
    expect(result.current.sectionTotals.in_progress).toBe(0);
    expect(result.current.sectionTotals.closed).toBe(0);
    expect(result.current.sectionTotals.cancelled).toBe(0);
    const requestedStatuses = new Set(trackerList.mock.calls.map(([args]) => args.status));
    expect(requestedStatuses).toEqual(new Set(["open"]));
  });

  it("growing options.sections fetches only the newly-added sections, without re-fetching what's already loaded (pas-2KY5X.4)", async () => {
    const trackerList = installClient({
      "prj-a:open:start": {
        trackers: [makeTracker("a-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 1 },
      },
      "prj-a:closed:start": {
        trackers: [makeTracker("a-closed-1", "closed")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 1 },
      },
    });
    const { result, rerender } = renderHook(
      ({ sections }: { sections: TrackerStatus[] | undefined }) =>
        useTrackerProjectData({
          projects: [PROJECT_A],
          selectedProjectId: null,
          all: true,
          enabled: true,
          pageSize: 50,
          sections,
        }),
      { initialProps: { sections: ["open"] as TrackerStatus[] | undefined } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.trackers.map((t) => t.id)).toEqual(["a-open-1"]);
    expect(trackerList.mock.calls.filter(([args]) => args.status === "open")).toHaveLength(1);

    // Grow the desired set to all four — e.g. switching from a List status
    // filter to Kanban, which always needs every lane.
    rerender({ sections: undefined });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // The already-loaded "open" row survives alongside the newly-fetched
    // "closed" one — "open" itself was never re-requested or reset.
    expect(result.current.trackers.map((t) => t.id).sort()).toEqual(["a-closed-1", "a-open-1"]);
    expect(trackerList.mock.calls.filter(([args]) => args.status === "open")).toHaveLength(1);
    expect(trackerList.mock.calls.filter(([args]) => args.status === "closed")).toHaveLength(1);
  });

  it("refetches once an offline host reconnects, instead of leaving the section empty for the session (pas-2KY5X.13)", async () => {
    setConnectionStatus("host-a", "offline");
    const trackerList = installClient({
      "prj-a:open:start": {
        trackers: [makeTracker("a-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 1 },
      },
    });

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // fetchTrackerPage short-circuits to an empty page for an offline host —
    // the section "loads" (isLoading settles) but stays empty, and the real
    // client.trackerList is never called.
    expect(result.current.trackers).toEqual([]);
    expect(trackerList).not.toHaveBeenCalled();

    act(() => {
      setConnectionStatus("host-a", "online");
    });

    const loadedIds = () => result.current.trackers.map((t) => t.id);
    await waitFor(() => expect(loadedIds()).toEqual(["a-open-1"]));
    expect(trackerList).toHaveBeenCalled();
  });

  it("a single host reconnecting retries only its own projects, leaving another project's loaded pages and paging cursor untouched (pas-2KY5X.13)", async () => {
    // host-a (prj-a) is online the whole time; host-b (prj-c) starts offline.
    setConnectionStatus("host-b", "offline");
    const trackerList = installClient({
      "prj-a:open:start": {
        trackers: [makeTracker("a-open-1")],
        hiddenCount: 0,
        // hasMore: true is the tell — if prj-a's section were ever wiped and
        // re-fetched, this cursor would be rebuilt from scratch rather than
        // surviving untouched.
        pageInfo: { nextCursor: "next", hasMore: true, totalCount: 5 },
      },
      "prj-c:open:start": {
        trackers: [makeTracker("c-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 1 },
      },
    });

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A, PROJECT_C],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // prj-a loaded normally; prj-c's host is offline, so it contributed
    // nothing even though the response table has data waiting for it.
    expect(result.current.trackers.map((t) => t.id)).toEqual(["a-open-1"]);
    expect(result.current.sectionHasMore.open).toBe(true);

    act(() => {
      setConnectionStatus("host-b", "online");
    });

    const loadedIds = () => result.current.trackers.map((t) => t.id).sort();
    await waitFor(() => expect(loadedIds()).toEqual(["a-open-1", "c-open-1"]));
    // prj-a's own "open" page was never re-requested — a global reset would
    // have refetched it (and every other project's every section) the moment
    // host-b's status changed at all, not just host-b's own projects.
    const prjAOpenRequests = trackerList.mock.calls.filter(
      ([args]) => args.projectId === "prj-a" && args.status === "open",
    );
    expect(prjAOpenRequests).toHaveLength(1);
    // prj-a's paging state survived the reconnect untouched.
    expect(result.current.sectionHasMore.open).toBe(true);
  });
});

function makeProjects(count: number): TrackerProjectInput[] {
  return Array.from({ length: count }, (_, index) => ({
    serverId: "host-a",
    serverName: "Host A",
    projectId: `prj-${index}`,
    projectName: `Project ${index}`,
    projectRootPath: `/repo/prj-${index}`,
  }));
}

function totalRowsFetched(
  fetchedRowCounts: { projectId: string; status: TrackerStatus | undefined; count: number }[],
  status: TrackerStatus,
): number {
  return fetchedRowCounts
    .filter((entry) => entry.status === status)
    .reduce((sum, entry) => sum + entry.count, 0);
}

/**
 * Serves each project a fixed, explicitly-dated, newest-first stream — unlike
 * installGenerousSortedClient, whose rows come off one shared clock that hands
 * every project a contiguous block, so project N's rows are ALL newer than
 * project N+1's. That shape can't express the case pas-2KY5X.29 is about: one
 * project dense in the recent window while others hold only old rows. Cursor
 * is the numeric offset into that project's own list, matching how the daemon
 * pages `ait list --sort newest`.
 */
function installDatedSortedClient(datesByProjectId: Record<string, readonly string[]>): {
  trackerList: ReturnType<typeof vi.fn>;
  fetchedRowCounts: { projectId: string; status: TrackerStatus | undefined; count: number }[];
} {
  const fetchedRowCounts: {
    projectId: string;
    status: TrackerStatus | undefined;
    count: number;
  }[] = [];
  const trackerList = vi.fn(
    async (args: {
      projectId: string;
      status?: TrackerStatus;
      page?: { limit: number; cursor?: string };
    }) => {
      const all = datesByProjectId[args.projectId] ?? [];
      const offset = args.page?.cursor ? Number(args.page.cursor) : 0;
      const limit = args.page?.limit ?? all.length;
      const slice = all.slice(offset, offset + limit);
      fetchedRowCounts.push({
        projectId: args.projectId,
        status: args.status,
        count: slice.length,
      });
      const nextOffset = offset + slice.length;
      return {
        trackers: slice.map((createdAt, index) => ({
          id: `${args.projectId}-${offset + index}`,
          title: `${args.projectId} @ ${createdAt}`,
          type: "task" as const,
          status: args.status ?? "open",
          priority: "P2" as const,
          parentId: null,
          createdAt,
        })),
        hiddenCount: 0,
        pageInfo: {
          nextCursor: nextOffset < all.length ? String(nextOffset) : null,
          hasMore: nextOffset < all.length,
          totalCount: all.length,
        },
      };
    },
  );
  runtimeState.getClient.mockReturnValue({
    trackerList,
    trackerSearch: vi.fn(),
    getLastServerInfoMessage: () => ({ features: { aitTrackerSort: true } }),
  });
  return { trackerList, fetchedRowCounts };
}

/**
 * Same shape as installGenerousSortedClient, but with two knobs pas-2KY5X.24
 * needs and the sort-mock doesn't expose: per-project supply that can differ
 * wildly (a real workspace never has evenly-stocked projects), and whether
 * `aitTrackerSort` is advertised at all — `sortSupported: false` forces every
 * relevant project onto the per-project pagination fallback instead of the
 * merged budget. `omitTotalForProjectId` drops `pageInfo.totalCount` from one
 * project's pages, standing in for an old CLI binary that predates
 * total_count — the daemon-side condition sectionTotals' "any project misses
 * its total, the whole section total goes null" contract exists for.
 */
function installVariableSupplyClient(options: {
  supplyByProjectId: Record<string, number>;
  sortSupported: boolean;
  omitTotalForProjectId?: string;
}): {
  trackerList: ReturnType<typeof vi.fn>;
} {
  let clock = 1_000_000;
  const remainingByKey = new Map<string, number>();
  const trackerList = vi.fn(
    async (args: {
      projectId: string;
      status?: TrackerStatus;
      page?: { limit: number; cursor?: string };
    }) => {
      const key = `${args.projectId}:${args.status}`;
      const total = options.supplyByProjectId[args.projectId] ?? 0;
      const remaining = remainingByKey.get(key) ?? total;
      const limit = args.page?.limit ?? total;
      const take = Math.max(0, Math.min(remaining, limit));
      const trackers: TrackerSummary[] = [];
      for (let i = 0; i < take; i++) {
        clock -= 1;
        trackers.push({
          id: `${args.projectId}-${clock}`,
          title: `Tracker ${clock}`,
          type: "task",
          status: args.status ?? "open",
          priority: "P2",
          parentId: null,
          createdAt: String(clock).padStart(10, "0"),
        });
      }
      const nextRemaining = remaining - take;
      remainingByKey.set(key, nextRemaining);
      return {
        trackers,
        hiddenCount: 0,
        pageInfo: {
          nextCursor: nextRemaining > 0 ? `cursor-${nextRemaining}` : null,
          hasMore: nextRemaining > 0,
          ...(args.projectId === options.omitTotalForProjectId ? {} : { totalCount: total }),
        },
      };
    },
  );
  runtimeState.getClient.mockReturnValue({
    trackerList,
    trackerSearch: vi.fn(),
    getLastServerInfoMessage: () => ({ features: { aitTrackerSort: options.sortSupported } }),
  });
  return { trackerList };
}

// Investigation for pas-2KY5X.24: the user saw the Kanban Done badge go
// 20, then 130, then 220 across three "Show 30 more" presses — not 30-row
// steps — and asked which of two causes was responsible: laneTotal being
// null (badge falling back to the loaded count) or loadMore fetching more
// than one step's worth per press.
describe("useTrackerProjectData loadMore step size (pas-2KY5X.24)", () => {
  beforeEach(() => {
    connectionStatusState.byServer = {};
  });

  it("merge mode: three successive loadMore presses each add at most pageSize rows, even with uneven per-project supply", async () => {
    const projects = makeProjects(3);
    const { trackerList } = installVariableSupplyClient({
      supplyByProjectId: { "prj-0": 50, "prj-1": 35, "prj-2": 15 },
      sortSupported: true,
    });

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects,
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 30,
        sections: ["closed"],
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const counts = [result.current.trackers.length];

    for (let press = 0; press < 3; press++) {
      act(() => {
        result.current.loadMore("closed");
      });
      await waitFor(() => expect(result.current.sectionLoadingMore.closed).toBe(false));
      counts.push(result.current.trackers.length);
    }

    const deltas = counts.slice(1).map((count, index) => count - counts[index]!);
    // eslint-disable-next-line no-console
    console.log(
      `pas-2KY5X.24 merge mode observed: loaded counts ${counts.join(" -> ")}` +
        ` (deltas ${deltas.join(", ")}), sectionTotals.closed=${result.current.sectionTotals.closed}`,
    );
    for (const delta of deltas) {
      expect(delta).toBeLessThanOrEqual(30);
    }
    // Every relevant project reported its total on round 1 of the very first
    // fetch (see fetchMergedStatusWindow) — sectionTotals is real and stable
    // from the start, not the loaded-so-far fallback.
    expect(result.current.sectionTotals.closed).toBe(100);
    expect(trackerList.mock.calls.some(([args]) => args.sort !== undefined)).toBe(true);
  });

  it("per-project fallback: loadMore adds one pageSize page PER project, so a press can add far more than pageSize rows — this is pre-existing per-project behaviour, not a merge-mode regression", async () => {
    const projects = makeProjects(3);
    // Generously stocked (well beyond pageSize per project per press) so no
    // project runs dry across the three presses below — that isolates the
    // per-project-vs-shared-budget difference from exhaustion effects, which
    // the merge-mode test above already covers separately with tight supply.
    installVariableSupplyClient({
      supplyByProjectId: { "prj-0": 200, "prj-1": 150, "prj-2": 120 },
      sortSupported: false,
    });

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects,
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 30,
        sections: ["closed"],
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const counts = [result.current.trackers.length];

    for (let press = 0; press < 3; press++) {
      act(() => {
        result.current.loadMore("closed");
      });
      await waitFor(() => expect(result.current.sectionLoadingMore.closed).toBe(false));
      counts.push(result.current.trackers.length);
    }

    const deltas = counts.slice(1).map((count, index) => count - counts[index]!);
    // eslint-disable-next-line no-console
    console.log(
      `pas-2KY5X.24 per-project fallback observed: loaded counts ${counts.join(" -> ")}` +
        ` (deltas ${deltas.join(", ")}), sectionTotals.closed=${result.current.sectionTotals.closed}`,
    );
    // Every project still in the running contributes up to pageSize(30) in
    // the same press — three still-hungry projects can add up to 90 in one
    // press, not <=30. The step size the button label promises only holds in
    // merge mode.
    expect(Math.max(...deltas)).toBeGreaterThan(30);
    // Every project still reports its own total per page here too — the
    // fallback path doesn't poison sectionTotals by itself; it takes a
    // project that never reports totalCount to do that (next test).
    expect(result.current.sectionTotals.closed).toBe(470);
  });

  it("per-project fallback with one project missing totalCount: the badge falls back to the loaded count, which then grows by more than pageSize per press", async () => {
    const projects = makeProjects(3);
    installVariableSupplyClient({
      supplyByProjectId: { "prj-0": 200, "prj-1": 150, "prj-2": 120 },
      sortSupported: false,
      // Stands in for one host on an old `ait` CLI that predates total_count
      // — plausible on the same host that also predates aitTrackerSort.
      omitTotalForProjectId: "prj-2",
    });

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects,
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 30,
        sections: ["closed"],
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // laneTotal (sectionTotals.closed) is null from the start — one project
    // never reports a total, which poisons the whole section per the
    // documented "a null from any one project poisons the whole section
    // total" contract (docs/tracker-data.md) — so the Kanban badge falls
    // back to `cards.length` (this hook's `trackers.length` here).
    expect(result.current.sectionTotals.closed).toBe(null);
    const badgeValues = [result.current.trackers.length];

    for (let press = 0; press < 3; press++) {
      act(() => {
        result.current.loadMore("closed");
      });
      await waitFor(() => expect(result.current.sectionLoadingMore.closed).toBe(false));
      expect(result.current.sectionTotals.closed).toBe(null);
      badgeValues.push(result.current.trackers.length);
    }

    // eslint-disable-next-line no-console
    console.log(`pas-2KY5X.24 badge-fallback observed sequence: ${badgeValues.join(" -> ")}`);
    const deltas = badgeValues.slice(1).map((count, index) => count - badgeValues[index]!);
    expect(Math.max(...deltas)).toBeGreaterThan(30);
  });
});

describe("useTrackerProjectData merge mode (pas-2KY5X.15)", () => {
  beforeEach(() => {
    connectionStatusState.byServer = {};
  });

  it("a single project in All-projects mode fetches exactly the budget, zero over-fetch", async () => {
    const { fetchedRowCounts } = installGenerousSortedClient({ "prj-0": 1000 });
    const projects = makeProjects(1);

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects,
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 30,
        sections: ["open"],
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.trackers).toHaveLength(30);
    expect(totalRowsFetched(fetchedRowCounts, "open")).toBe(30);
  });

  it("nine generously-stocked projects in All-projects mode fetch close to the budget, nowhere near budget-per-project (pas-2KY5X.15)", async () => {
    const projects = makeProjects(9);
    const supply: Record<string, number> = {};
    for (const project of projects) {
      supply[project.projectId] = 1000;
    }
    const { trackerList, fetchedRowCounts } = installGenerousSortedClient(supply);

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects,
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 30,
        sections: ["open"],
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // The budget itself is exact regardless of project count.
    expect(result.current.trackers).toHaveLength(30);

    const fetched = totalRowsFetched(fetchedRowCounts, "open");
    const requestCount = trackerList.mock.calls.filter(([args]) => args.status === "open").length;
    // eslint-disable-next-line no-console
    console.log(
      `pas-2KY5X.15 measured: 9 projects, budget 30 -> ${fetched} rows fetched over ${requestCount} requests` +
        ` (old per-project behaviour would have fetched 9 * 30 = 270)`,
    );
    // The old per-project design fetched 270 here (30 per project); this
    // asserts the fix stays well clear of that, not a specific number, since
    // the exact figure depends on how evenly this mock's shared clock
    // happens to interleave — see the console.log above for the actual
    // measured count on this run.
    expect(fetched).toBeLessThan(90);
    expect(fetched).toBeGreaterThanOrEqual(30);
  });

  // The shape that shipped broken (pas-2KY5X.29), reproduced from real data:
  // one project owns almost the whole recent window while the others hold only
  // much older rows. Filling every buffer to `budget` rows and THEN taking the
  // newest `budget` of them — the old implementation — asks each project for
  // budget/N and stops, so the window is "the newest few from each project"
  // and the dense project's rows 6..30, newer than everything the sparse ones
  // contributed, never get fetched at all. The user sees a page topped by
  // months-old rows, and clicking "Show more" then drops genuinely newer rows
  // ABOVE what is already on screen.
  it("fills the window from whichever project owns the recent range, not budget/N from each", async () => {
    // Strictly decreasing by the hour, one index at a time — the day-vs-hour
    // formula this replaced (`23 - (index % 24)` alongside `index / 50` for
    // the day) wrapped the hour back to 23 every 24 entries without the day
    // rolling over to match, so index 0 and index 24 both landed on
    // "2026-08-20T23:00:00.000Z" — a fixture bug that violated
    // installDatedSortedClient's own "newest-first stream" contract. The old
    // sortMerged global re-sort silently absorbed that; pas-2KY5X.37 removed
    // it from the merged path specifically so a genuinely out-of-order
    // stream is no longer masked.
    const dense = Array.from({ length: 100 }, (_, index) =>
      new Date(Date.UTC(2026, 7, 24, 23, 0, 0) - index * 3_600_000).toISOString(),
    );
    const sparse = ["2026-01-05T00:00:00.000Z", "2026-01-04T00:00:00.000Z"];
    const { fetchedRowCounts } = installDatedSortedClient({
      "prj-0": dense,
      "prj-1": sparse,
      "prj-2": sparse,
      "prj-3": sparse,
      "prj-4": sparse,
    });

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: makeProjects(5),
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 30,
        sections: ["open"],
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // A full page, not the 6-per-project the old fill-then-take produced.
    expect(result.current.trackers).toHaveLength(30);

    // Every row in the window comes from the dense project: the sparse ones'
    // January rows are older than all 100 of its August rows, so a correct
    // newest-first window contains none of them. The old code put 8 of them
    // on screen (2 from each sparse project) and left the dense project's
    // rows 6..30 unfetched.
    const projectsInWindow = new Set(result.current.trackers.map((t) => t.projectId));
    expect([...projectsInWindow]).toEqual(["prj-0"]);

    // Rows come out in newest-first order (non-increasing createdAt — this
    // fixture's hourly clock wraps every 24 entries, so real ties are part
    // of what's being checked here), with no duplicates. A pairwise check
    // rather than sort().toReversed(): pas-2KY5X.37 stopped re-sorting the
    // merged path, so tied rows now keep the k-way merge's own emission
    // order instead of a fresh global sort's tiebreak order — both are
    // valid "newest-first" orderings for a tie, but only a pairwise check
    // tolerates either.
    const createdAts = result.current.trackers.map((t) => t.createdAt);
    for (let i = 1; i < createdAts.length; i++) {
      expect(createdAts[i]! <= createdAts[i - 1]!).toBe(true);
    }
    expect(new Set(result.current.trackers.map((t) => t.id)).size).toBe(30);

    // Correctness here costs round-trips (the sparse projects each have to be
    // asked once before their absence from the window is provable), but stays
    // far below what a page-per-project fetch would have cost.
    const fetched = totalRowsFetched(fetchedRowCounts, "open");
    expect(fetched).toBeLessThan(5 * 30);
  });

  it("appends strictly older rows on loadMore, never above what is already shown", async () => {
    const dense = Array.from({ length: 200 }, (_, index) =>
      new Date(Date.UTC(2026, 7, 24, 0, 0, 0) - index * 60_000).toISOString(),
    );
    installDatedSortedClient({
      "prj-0": dense,
      "prj-1": dense.slice(1).filter((_, index) => index % 3 === 0),
      "prj-2": dense.slice(2).filter((_, index) => index % 5 === 0),
    });

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: makeProjects(3),
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 30,
        sections: ["open"],
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const firstPage = result.current.trackers.map((t) => t.createdAt);
    expect(firstPage).toHaveLength(30);

    act(() => {
      result.current.loadMore("open");
    });
    await waitFor(() => expect(result.current.sectionLoadingMore.open).toBe(false));

    // The whole point: page 2's rows are all older than page 1's last row, so
    // they extend the bottom of the list instead of being interleaved into it.
    // The old merge could surface a row newer than rows already on screen here,
    // which is what made "Show more" visibly reshuffle the view.
    const afterAll = result.current.trackers.map((t) => t.createdAt);
    expect(afterAll.slice(0, 30)).toEqual(firstPage);
    const oldestOnFirstPage = firstPage[firstPage.length - 1]!;
    for (const createdAt of afterAll.slice(30)) {
      expect(createdAt! <= oldestOnFirstPage).toBe(true);
    }
    expect(new Set(result.current.trackers.map((t) => t.id)).size).toBe(afterAll.length);
  });

  it("loadMore in merge mode continues the recency window without skipping or repeating rows", async () => {
    const projects = makeProjects(3);
    const supply: Record<string, number> = {};
    for (const project of projects) {
      supply[project.projectId] = 1000;
    }
    installGenerousSortedClient(supply);

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects,
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 5,
        sections: ["open"],
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const firstWindow = result.current.trackers.map((t) => t.id);
    expect(firstWindow).toHaveLength(5);

    act(() => {
      result.current.loadMore("open");
    });
    await waitFor(() => expect(result.current.sectionLoadingMore.open).toBe(false));
    const combined = result.current.trackers.map((t) => t.id);
    expect(combined).toHaveLength(10);

    // No repeats between the two windows...
    const combinedSet = new Set(combined);
    expect(combinedSet.size).toBe(10);
    // ...and no gap: this mock hands out a strictly decreasing, globally
    // shared clock as each row's createdAt, so a genuinely contiguous top-10
    // window (no row skipped in between) has a max-min span of exactly 9 —
    // a skip would widen it, a repeat would already have failed the Set-size
    // check above. Not asserting the hook's own array order here: the
    // exported `trackers` are kept in projectId/id order for internal
    // bookkeeping (TrackerTable/Kanban each impose their own display order),
    // not recency order.
    const combinedClocks = result.current.trackers
      .map((t) => Number(t.createdAt))
      .sort((a, b) => a - b);
    expect(combinedClocks).toHaveLength(10);
    expect(combinedClocks[9]! - combinedClocks[0]!).toBe(9);
  });

  it("falls back to per-project pagination (budget per project, not shared) when a relevant project's host doesn't advertise aitTrackerSort", async () => {
    const trackerList = installClient({
      "prj-a:open:start": {
        trackers: [makeTracker("a-1"), makeTracker("a-2")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 2 },
      },
      "prj-b:open:start": {
        trackers: [makeTracker("b-1"), makeTracker("b-2")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 2 },
      },
    });

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A, PROJECT_B],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 30,
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // Both projects' full (small) result sets came through — the fallback
    // never narrowed a project's own page below what it had, it only
    // dropped pageSize from 50 to 30 (a separate, tracker-screen.tsx-level
    // change) rather than sharing one budget across projects.
    expect(result.current.trackers.map((t) => t.id).sort()).toEqual(["a-1", "a-2", "b-1", "b-2"]);
    expect(trackerList.mock.calls.some(([args]) => args.sort !== undefined)).toBe(false);
  });

  it("sectionTotals still sums pageInfo.totalCount per project under the merged fetch shape (pas-2KY5X.15)", async () => {
    const projects = makeProjects(3);
    installGenerousSortedClient({ "prj-0": 12, "prj-1": 7, "prj-2": 3 });

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects,
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 5,
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // 12 + 7 + 3 = 22 total matches, independent of the 5-row budget window
    // actually displayed — sectionTotals is never bounded by the budget.
    expect(result.current.sectionTotals.open).toBe(22);
  });

  it("a single selected project still requests sort: newest when its host supports it, budgeted at pageSize as before", async () => {
    const { trackerList } = installGenerousSortedClient({ "prj-0": 1000 });
    const projects = makeProjects(1);

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects,
        selectedProjectId: "prj-0",
        all: true,
        enabled: true,
        pageSize: 30,
        sections: ["open"],
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.trackers).toHaveLength(30);
    const openCalls = trackerList.mock.calls.filter(([args]) => args.status === "open");
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0]?.[0]?.sort).toBe("newest");
  });
});

// pas-2KY5X.25 root cause #1: allSupportSort used to read
// getLastServerInfoMessage() with no regard for connectionStatus, so
// "hello not landed yet" (undefined) and "hello landed, capability
// genuinely false" both read as false. On a fresh mount that fetched
// per-project-fallback immediately, then flipped every relevant project's
// capability to `true` the instant every hello resolved, that flip changed
// scopeKey (mergeMode is baked into it) and wiped+refetched everything
// under merge/budget mode — a big-number-to-small-number reset right after
// first paint. These tests drive `getLastServerInfoMessage` off
// `connectionStatus` the same way the real daemon-client guarantees it
// (server_info is set one call before connectionState flips to
// "connected" — verified in packages/client/src/daemon-client.ts), so
// "connecting" genuinely means "don't know yet", not "known false".
describe("useTrackerProjectData sort-capability race (pas-2KY5X.25)", () => {
  beforeEach(() => {
    connectionStatusState.byServer = {};
  });

  /** Mirrors installGenerousSortedClient, but getLastServerInfoMessage
   * answers based on `serverId`'s live connectionStatus instead of a fixed
   * value — undefined while not "online", the real feature flag once
   * "online" — matching the guarantee this fix depends on. */
  function installHelloGatedSortedClient(
    serverId: string,
    supplyByProjectId: Record<string, number>,
  ): {
    trackerList: ReturnType<typeof vi.fn>;
    fetchedRowCounts: { projectId: string; status: TrackerStatus | undefined; count: number }[];
  } {
    let clock = 1_000_000;
    const remainingByKey = new Map<string, number>();
    const fetchedRowCounts: {
      projectId: string;
      status: TrackerStatus | undefined;
      count: number;
    }[] = [];
    const trackerList = vi.fn(
      async (args: {
        projectId: string;
        status?: TrackerStatus;
        page?: { limit: number; cursor?: string };
      }) => {
        const key = `${args.projectId}:${args.status}`;
        const total = supplyByProjectId[args.projectId] ?? 0;
        const remaining = remainingByKey.get(key) ?? total;
        const limit = args.page?.limit ?? total;
        const take = Math.max(0, Math.min(remaining, limit));
        fetchedRowCounts.push({ projectId: args.projectId, status: args.status, count: take });
        const trackers: TrackerSummary[] = [];
        for (let i = 0; i < take; i++) {
          clock -= 1;
          trackers.push({
            id: `${args.projectId}-${clock}`,
            title: `Tracker ${clock}`,
            type: "task",
            status: args.status ?? "open",
            priority: "P2",
            parentId: null,
            createdAt: String(clock).padStart(10, "0"),
          });
        }
        const nextRemaining = remaining - take;
        remainingByKey.set(key, nextRemaining);
        return {
          trackers,
          hiddenCount: 0,
          pageInfo: {
            nextCursor: nextRemaining > 0 ? `cursor-${nextRemaining}` : null,
            hasMore: nextRemaining > 0,
            totalCount: total,
          },
        };
      },
    );
    runtimeState.getClient.mockReturnValue({
      trackerList,
      trackerSearch: vi.fn(),
      getLastServerInfoMessage: () =>
        (connectionStatusState.byServer[serverId] ?? "online") === "online"
          ? { features: { aitTrackerSort: true } }
          : undefined,
    });
    return { trackerList, fetchedRowCounts };
  }

  it("defers the first fetch while a relevant host's hello is still in flight, instead of fetching per-project-fallback then discarding it once merge mode resolves", async () => {
    const projects = makeProjects(3); // makeProjects puts every project on "host-a"
    setConnectionStatus("host-a", "connecting");
    const { trackerList, fetchedRowCounts } = installHelloGatedSortedClient("host-a", {
      "prj-0": 50,
      "prj-1": 50,
      "prj-2": 50,
    });

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects,
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 30,
        sections: ["open"],
      }),
    );

    // Nothing fetched, and no premature "done, zero rows" resolution, while
    // the hello is still in flight — isLoading stays true instead of
    // settling on an empty page that a reset would later overwrite.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(trackerList).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.trackers).toEqual([]);

    act(() => {
      setConnectionStatus("host-a", "online");
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // Exactly the merge-mode budget, gathered under the correct mode from the
    // start — never a per-project-fallback page fetched and thrown away the
    // instant capability resolved. This test is about WHICH mode ran, so it
    // asserts the rows, plus that the fetch stayed well under what the
    // fallback would have cost (3 projects x 30 = 90); the exact row count is
    // pinned by the merge tests above, not here. It is deliberately not "30
    // fetched for 30 shown": a correct k-way merge cannot know it has the
    // newest 30 until every stream that drained at the frontier has been
    // refilled and shown to hold nothing newer, so some over-fetch is the
    // price of the window being right (pas-2KY5X.29).
    expect(result.current.trackers).toHaveLength(30);
    const helloGatedFetched = totalRowsFetched(fetchedRowCounts, "open");
    expect(helloGatedFetched).toBeGreaterThanOrEqual(30);
    expect(helloGatedFetched).toBeLessThan(90);
    expect(trackerList.mock.calls.some(([args]) => args.sort !== undefined)).toBe(true);
  });

  // Hoisted out of the test body (rather than defined inline inside
  // mockImplementation's callback) purely to keep max-nested-callbacks
  // happy: describe > it > mockImplementation > vi.fn is already 4 deep.
  function installHelloGatedSingleTrackerClient(
    trackerListByHost: Map<string, ReturnType<typeof vi.fn>>,
  ): void {
    runtimeState.getClient.mockImplementation((serverId: string) => {
      const trackerList = vi.fn(async () => ({
        trackers: [makeTracker(`${serverId}-open-1`)],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 1 },
      }));
      trackerListByHost.set(serverId, trackerList);
      return {
        trackerList,
        trackerSearch: vi.fn(),
        getLastServerInfoMessage: () =>
          (connectionStatusState.byServer[serverId] ?? "online") === "online"
            ? { features: { aitTrackerSort: true } }
            : undefined,
      };
    });
  }

  it("waits for every relevant host, not just the first to resolve, before picking a fetch strategy", async () => {
    const projectOnHostA: TrackerProjectInput = {
      serverId: "host-a",
      serverName: "Host A",
      projectId: "prj-a",
      projectName: "Project A",
      projectRootPath: "/repo/prj-a",
    };
    const projectOnHostB: TrackerProjectInput = {
      serverId: "host-b",
      serverName: "Host B",
      projectId: "prj-b",
      projectName: "Project B",
      projectRootPath: "/repo/prj-b",
    };
    setConnectionStatus("host-a", "online");
    setConnectionStatus("host-b", "connecting");

    const trackerListByHost = new Map<string, ReturnType<typeof vi.fn>>();
    installHelloGatedSingleTrackerClient(trackerListByHost);

    const { result } = renderHook(() =>
      // `projects` is a fresh array literal on every render on purpose (not
      // hoisted to a stable `const` like other tests in this file) — this
      // caught a real infinite-render-loop bug in the first version of the
      // pas-2KY5X.25 fix: syncSections' own identity depends (via
      // runMergedFetch) on relevantProjects, which is only reference-stable
      // if the caller memoizes `options.projects`, so a deferred-fetch
      // implementation that redid its reset on every repeat call (instead of
      // a true no-op) looped forever the moment a caller didn't.
      useTrackerProjectData({
        projects: [projectOnHostA, projectOnHostB],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 30,
        sections: ["open"],
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // host-a resolved but host-b hasn't — the whole scope waits rather than
    // fetching host-a alone under a guessed mode. getClient("host-a") may
    // still be called (to check its own capability while deciding whether
    // every relevant project has resolved), so the real invariant is that
    // its trackerList is never actually invoked to fetch data, not that the
    // client was never looked up.
    expect(result.current.isLoading).toBe(true);
    expect(trackerListByHost.get("host-a")?.mock.calls ?? []).toHaveLength(0);

    act(() => {
      setConnectionStatus("host-b", "online");
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.trackers.map((t) => t.id).sort()).toEqual([
      "host-a-open-1",
      "host-b-open-1",
    ]);
  });

  // Same hoist-to-avoid-4-deep-nesting reasoning as
  // installHelloGatedSingleTrackerClient above.
  function makeOnlineSingleTrackerClient(trackerId: string): {
    trackerList: ReturnType<typeof vi.fn>;
    trackerSearch: ReturnType<typeof vi.fn>;
    getLastServerInfoMessage: () => { features: { aitTrackerSort: boolean } };
  } {
    return {
      trackerList: vi.fn(async () => ({
        trackers: [makeTracker(trackerId)],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 1 },
      })),
      trackerSearch: vi.fn(),
      getLastServerInfoMessage: () => ({ features: { aitTrackerSort: true } }),
    };
  }
  function makeUnreachableClient(): {
    trackerList: ReturnType<typeof vi.fn>;
    trackerSearch: ReturnType<typeof vi.fn>;
    getLastServerInfoMessage: () => undefined;
  } {
    return {
      trackerList: vi.fn(),
      trackerSearch: vi.fn(),
      getLastServerInfoMessage: () => undefined,
    };
  }

  it("an offline (not merely connecting) relevant project resolves to 'doesn't support' immediately, instead of blocking every other project's fetch", async () => {
    const projectOnHostA: TrackerProjectInput = {
      serverId: "host-a",
      serverName: "Host A",
      projectId: "prj-a",
      projectName: "Project A",
      projectRootPath: "/repo/prj-a",
    };
    const projectOnHostB: TrackerProjectInput = {
      serverId: "host-b",
      serverName: "Host B",
      projectId: "prj-b",
      projectName: "Project B",
      projectRootPath: "/repo/prj-b",
    };
    setConnectionStatus("host-a", "online");
    setConnectionStatus("host-b", "offline");

    // host-b is offline — it never got a hello.
    runtimeState.getClient.mockImplementation((serverId: string) =>
      serverId === "host-a" ? makeOnlineSingleTrackerClient("a-open-1") : makeUnreachableClient(),
    );

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [projectOnHostA, projectOnHostB],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 30,
        // Narrowed to one status — host-a's mock ignores args.status and
        // always returns the same "open" tracker, so fetching all four
        // statuses would file that same row under every section.
        sections: ["open"],
      }),
    );

    // host-a's data loads right away — an offline host-b (which will keep
    // cycling offline/connecting on its own reconnect backoff, never a
    // permanent state) does not stall the whole scope waiting for a hello
    // that may not land for a while.
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.trackers.map((t) => t.id)).toEqual(["a-open-1"]);
  });
});

// pas-2KY5X.25 root cause #2: sectionTotals used to blank the whole status
// section to `null` the instant ANY in-scope project's cursorState was
// missing or errored — including simply "hasn't answered yet", the normal
// state of most projects for most of a fresh load. tracker-table.tsx falls
// back to `trackers.length` (the loaded-so-far row count) whenever total is
// null, so while a merge-mode/budgeted fetch was still resolving across N
// projects, the badge showed a small, growing "rows loaded so far" number
// instead of the real (larger) total — the pas-2KY5X.14 anti-pattern the
// toolbar pills were already fixed for, never applied here. These tests
// mirror that fix: a project that hasn't answered yet or whose fetch failed
// contributes nothing (never poisons), same as useTrackerStats.
describe("useTrackerProjectData sectionTotals partial sum (pas-2KY5X.25)", () => {
  beforeEach(() => {
    connectionStatusState.byServer = {};
  });

  // A single syncSections call applies its whole batch to state atomically
  // (one setSections/applyMergedResult call after every targeted project's
  // Promise.all settles, not one per project as each resolves) — so a
  // project "still in flight" is never visible mid-fetch via
  // result.current within one such call, in either merge or per-project
  // mode. retryReconnectedProjects is the one path that genuinely applies
  // one project's result independently of another's (pas-2KY5X.13): each
  // reconnecting project calls mergePage/setProjectCursor for itself the
  // moment its own fetch resolves. This test uses that path to exercise a
  // real (not simulated) partial-sum window.
  // Hoisted out of the test body to keep max-nested-callbacks under its
  // limit (describe > it > mockImplementation > vi.fn is already 4 deep).
  function makeReportedTotalClient(
    trackerId: string,
    totalCount: number,
  ): {
    trackerList: ReturnType<typeof vi.fn>;
    trackerSearch: ReturnType<typeof vi.fn>;
    getLastServerInfoMessage: () => { features: { aitTrackerSort: boolean } };
  } {
    return {
      trackerList: vi.fn(async () => ({
        trackers: [makeTracker(trackerId)],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount },
      })),
      trackerSearch: vi.fn(),
      getLastServerInfoMessage: () => ({ features: { aitTrackerSort: false } }),
    };
  }
  function makePendingReconnectClient(pending: Promise<ListResponse>): {
    trackerList: ReturnType<typeof vi.fn>;
    trackerSearch: ReturnType<typeof vi.fn>;
    getLastServerInfoMessage: () => { features: { aitTrackerSort: boolean } };
  } {
    return {
      trackerList: vi.fn(async () => pending),
      trackerSearch: vi.fn(),
      getLastServerInfoMessage: () => ({ features: { aitTrackerSort: false } }),
    };
  }

  it("sums whichever projects have reported so far instead of blanking the whole section while another is still catching up after a reconnect", async () => {
    const projectOnHostA: TrackerProjectInput = {
      serverId: "host-a",
      serverName: "Host A",
      projectId: "prj-a",
      projectName: "Project A",
      projectRootPath: "/repo/prj-a",
    };
    const projectOnHostB: TrackerProjectInput = {
      serverId: "host-b",
      serverName: "Host B",
      projectId: "prj-b",
      projectName: "Project B",
      projectRootPath: "/repo/prj-b",
    };
    setConnectionStatus("host-a", "online");
    setConnectionStatus("host-b", "offline");

    let resolveReconnect: ((value: ListResponse) => void) | null = null;
    const reconnectPromise = new Promise<ListResponse>((resolve) => {
      resolveReconnect = resolve;
    });
    runtimeState.getClient.mockImplementation((serverId: string) =>
      serverId === "host-a"
        ? makeReportedTotalClient("a-open-1", 5)
        : makePendingReconnectClient(reconnectPromise),
    );

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [projectOnHostA, projectOnHostB],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
        sections: ["open"],
      }),
    );

    // prj-a (online) loaded normally; prj-b's host is offline, contributing
    // nothing (matches the "an offline project" test above — 0 rows, safe
    // to skip, no poison) so the total already reflects prj-a alone.
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.sectionTotals.open).toBe(5);

    act(() => {
      setConnectionStatus("host-b", "online");
    });

    // host-b's reconnect retry is now in flight but hasn't resolved — the
    // total must not dip to null (and fall back to a smaller
    // trackers.length) while it's pending.
    expect(result.current.sectionTotals.open).toBe(5);

    await act(async () => {
      resolveReconnect?.({
        trackers: [makeTracker("b-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 3 },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const loadedIds = () => result.current.trackers.map((t) => t.id).sort();
    await waitFor(() => expect(loadedIds()).toEqual(["a-open-1", "b-open-1"]));
    expect(result.current.sectionTotals.open).toBe(8);
  });

  it("a project whose fetch errors contributes nothing to the sum, instead of blanking the whole section (mirrors useTrackerStats' pas-2KY5X.14 fix)", async () => {
    installClient({
      "prj-a:open:start": {
        trackers: [makeTracker("a-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 5 },
      },
      "prj-b:open:start": () => Promise.reject(new Error("boom")),
    });

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A, PROJECT_B],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
        sections: ["open"],
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.sectionTotals.open).toBe(5);
    expect(result.current.projectErrors).toHaveLength(1);
  });

  it("a project that responds successfully but omits totalCount still poisons the section to null, since it may have contributed real rows (unlike a missing or errored project)", async () => {
    installClient({
      "prj-a:open:start": {
        trackers: [makeTracker("a-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 5 },
      },
      "prj-b:open:start": {
        trackers: [makeTracker("b-open-1"), makeTracker("b-open-2")],
        hiddenCount: 0,
        // No totalCount — an old CLI binary predating total_count, still
        // very much a real page of rows.
        pageInfo: { nextCursor: null, hasMore: false },
      },
    });

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A, PROJECT_B],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
        sections: ["open"],
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.trackers).toHaveLength(3);
    // Poisoned to null rather than summing prj-a's 5 alone (which would
    // undercount below the 3 rows actually on screen) or treating prj-b as
    // contributing 0 (same undercount, worse than the un-fixed bug).
    expect(result.current.sectionTotals.open).toBeNull();
  });
});

describe("useTrackerProjectData merge-path position stability (pas-2KY5X.37)", () => {
  beforeEach(() => {
    connectionStatusState.byServer = {};
  });

  // created_at has second resolution, so ties are the norm, not the
  // exception (paseo's own .ait/ait.db: 47 rows over 24 distinct timestamps,
  // largest tie group 7) — three projects, three rows each, all tied at the
  // same instant, is a realistic shape, not a contrived edge case.
  it("a tied row already on screen keeps its exact position when a later page arrives", async () => {
    const T = "2026-08-24T00:00:00.000Z";
    const tied = [T, T, T];
    installDatedSortedClient({ "prj-0": tied, "prj-1": tied, "prj-2": tied });

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: makeProjects(3),
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 4,
        sections: ["open"],
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const firstPage = result.current.trackers.map((t) => t.id);
    expect(firstPage).toHaveLength(4);

    act(() => {
      result.current.loadMore("open");
    });
    await waitFor(() => expect(result.current.sectionLoadingMore.open).toBe(false));

    // The property: every row from page one keeps the exact array position
    // it had before page two arrived. Before pas-2KY5X.37, applyMergedResult
    // re-sorted the WHOLE accumulated array on every page with a comparator
    // whose tie fallback (id) has no relationship to fetch order — a
    // same-tied row arriving on page two could rank above (by id) a row
    // already shown from page one, and visibly jump above it. Fails against
    // the pre-fix source: this is the "byte-identical position" test.
    const afterPageTwo = result.current.trackers.map((t) => t.id);
    expect(afterPageTwo.slice(0, 4)).toEqual(firstPage);
    // 9 rows total (3 projects x 3), budget 4 per page — the second page
    // exhausts two projects' remaining tied rows and stops at budget, one
    // row (the third project's last) still unfetched for a third page.
    expect(afterPageTwo).toHaveLength(8);
  });
});

describe("useTrackerProjectData reconnect retry (pas-2KY5X.38)", () => {
  beforeEach(() => {
    connectionStatusState.byServer = {};
  });

  // Per-project mode throughout (installClient below advertises no
  // aitTrackerSort): unlike merge mode, whose `mergeMode` flag is itself
  // baked into scopeKey (so a project's connectivity flipping ALSO flips
  // `allSupportSort` and forces a full scope reset — a real but separate
  // behavior, not what this test is about), per-project mode's cursors are
  // untouched by connectivity changes, which is what isolates the exact
  // mechanism pas-2KY5X.38 is about.
  //
  // Reproduces the bug exactly as found: offlineProjectKeysRef used to be
  // keyed by project alone, so ONE status (here, "closed") going offline
  // flagged the whole project — on reconnect, retryReconnectedProjects
  // retried every status that project had ever been asked for, including
  // "open", which was never interrupted and still had a perfectly valid
  // cursor. retryOne also sent no cursor at all, so that retry restarted
  // "open" from offset 0 and re-fetched a row already on screen.
  it("reconnect does not re-fetch a status that never went offline, and never duplicates a row", async () => {
    // PROJECT_C, not PROJECT_B: PROJECT_A and PROJECT_B share `serverId:
    // "host-a"` (see their definitions above), so connectivity can't be
    // flipped for one without the other. PROJECT_C is the only other fixture
    // project on its own host ("host-b"), which this test needs to take
    // offline independently of PROJECT_A.
    const trackerList = installClient({
      "prj-a:open:start": {
        trackers: [makeTracker("A-o1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: "a-o-2", hasMore: true },
      },
      "prj-c:open:start": {
        trackers: [makeTracker("C-o1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: "c-o-2", hasMore: true },
      },
      "prj-a:closed:start": {
        trackers: [makeTracker("A-c1", "closed")],
        hiddenCount: 0,
        pageInfo: { nextCursor: "a-c-2", hasMore: true },
      },
      "prj-c:closed:start": {
        trackers: [makeTracker("C-c1", "closed")],
        hiddenCount: 0,
        pageInfo: { nextCursor: "c-c-2", hasMore: true },
      },
      "prj-a:closed:a-c-2": {
        trackers: [makeTracker("A-c2", "closed")],
        hiddenCount: 0,
        pageInfo: { nextCursor: "a-c-3", hasMore: true },
      },
      "prj-c:closed:c-c-2": {
        trackers: [makeTracker("C-c2", "closed")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false },
      },
    });

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A, PROJECT_C],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 1,
        sections: ["open", "closed"],
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.trackers.map((t) => t.id).sort()).toEqual([
      "A-c1",
      "A-o1",
      "C-c1",
      "C-o1",
    ]);

    // C's host drops, then "closed" pages again for BOTH projects (per-project
    // mode fans every relevant project out on one loadMore call) — the only
    // point in this test where C is asked for anything while offline. C's
    // "open" cursor (real, hasMore: true) is never touched by this call.
    setConnectionStatus("host-b", "offline");
    act(() => {
      result.current.loadMore("closed");
    });
    await waitFor(() => expect(result.current.sectionLoadingMore.closed).toBe(false));
    // A's own "closed" page advanced normally; C contributed nothing (still
    // offline) — and C's cursor must have survived, not been reset to
    // {cursor: null, hasMore: false} (the pas-2KY5X.38 sub-finding): if it
    // had, `sectionHasMore.closed` would already be wrong here, before
    // reconnect even enters the picture.
    expect(result.current.trackers.map((t) => t.id).sort()).toEqual([
      "A-c1",
      "A-c2",
      "A-o1",
      "C-c1",
      "C-o1",
    ]);
    expect(result.current.sectionHasMore.closed).toBe(true);

    // C reconnects.
    act(() => {
      setConnectionStatus("host-b", "online");
    });
    const hasCC2 = () => result.current.trackers.some((t) => t.id === "C-c2");
    await waitFor(() => expect(hasCC2()).toBe(true));

    // The property: C's "closed" resumed from its own real cursor ("c-c-2"),
    // picking up exactly where the offline attempt left off — not duplicating
    // C-c1, and not restarting from offset 0.
    expect(result.current.trackers.map((t) => t.id).sort()).toEqual([
      "A-c1",
      "A-c2",
      "A-o1",
      "C-c1",
      "C-c2",
      "C-o1",
    ]);

    // DIRECT proof of the specific bug: C's "open" page was requested from
    // the start (no cursor) exactly once — at mount. "open" was never
    // interrupted, so the reconnect retry has no legitimate reason to ask
    // for it again.
    const openStartCallsForC = trackerList.mock.calls.filter(
      ([args]) =>
        args.projectId === "prj-c" && args.status === "open" && args.page?.cursor === undefined,
    );
    expect(openStartCallsForC).toHaveLength(1);
  });
});

describe("useTrackerProjectData per-project sort gate (pas-2KY5X.36)", () => {
  beforeEach(() => {
    connectionStatusState.byServer = {};
  });

  // PROJECT_A and PROJECT_B share `serverId: "host-a"` (capable), PROJECT_C
  // is the only fixture project on a different host ("host-b", incapable) —
  // exactly "two projects with the capability, one without" without adding a
  // fourth project. One incapable project already forces mergeMode off
  // (allSupportSort requires EVERY relevant project), landing every fetch on
  // the per-project path this bug lived in.
  it("still requests sort:newest for projects whose own host supports it, when one relevant project's host does not", async () => {
    const responses: Record<string, ListResponse> = {
      "prj-a:open:start": {
        trackers: [makeTracker("a-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 1 },
      },
      "prj-b:open:start": {
        trackers: [makeTracker("b-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 1 },
      },
      "prj-c:open:start": {
        trackers: [makeTracker("c-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: null, hasMore: false, totalCount: 1 },
      },
    };
    const trackerList = vi.fn(
      async (args: {
        projectId: string;
        status?: TrackerStatus;
        sort?: string;
        page?: { cursor?: string };
      }) => {
        const key = `${args.projectId}:${args.status}:${args.page?.cursor ?? "start"}`;
        return responses[key] ?? EMPTY_PAGE;
      },
    );
    runtimeState.getClient.mockImplementation((serverId: string) => ({
      trackerList,
      trackerSearch: vi.fn(),
      // host-a (prj-a, prj-b) supports aitTrackerSort; host-b (prj-c) does
      // not — the two-hosts-one-incapable shape pas-2KY5X.36 is about.
      getLastServerInfoMessage: () => ({ features: { aitTrackerSort: serverId === "host-a" } }),
    }));

    const { result } = renderHook(() =>
      useTrackerProjectData({
        projects: [PROJECT_A, PROJECT_B, PROJECT_C],
        selectedProjectId: null,
        all: true,
        enabled: true,
        pageSize: 50,
        sections: ["open"],
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // One relevant project (prj-c) lacks the capability, so mergeMode never
    // engages — every fetch here goes through the per-project path.
    expect(result.current.trackers.map((t) => t.id).sort()).toEqual([
      "a-open-1",
      "b-open-1",
      "c-open-1",
    ]);

    const sortArgFor = (projectId: string): string | undefined =>
      trackerList.mock.calls.find(([args]) => args.projectId === projectId)?.[0]?.sort;
    // CLAIM: prj-a and prj-b's own host supports sort — they must still get
    // it even though prj-c's host doesn't. Before pas-2KY5X.36, `sort` was
    // gated on `allSupportSort` (workspace-wide), so prj-c's missing
    // capability silenced it for prj-a and prj-b too, and every project
    // (including the two capable ones) fell back to `ait`'s
    // `--sort oldest` default.
    expect(sortArgFor("prj-a")).toBe("newest");
    expect(sortArgFor("prj-b")).toBe("newest");
    // prj-c genuinely doesn't support it — must not be sent regardless.
    expect(sortArgFor("prj-c")).toBeUndefined();
  });
});
