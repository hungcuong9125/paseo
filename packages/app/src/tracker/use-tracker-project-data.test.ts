/**
 * @vitest-environment jsdom
 */
import React, { useEffect, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { Pressable } from "react-native";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const PROJECT_A: TrackerProjectInput = {
  serverId: "host-a",
  serverName: "Host A",
  projectId: "prj-a",
  projectName: "Project A",
};
const PROJECT_B: TrackerProjectInput = {
  serverId: "host-a",
  serverName: "Host A",
  projectId: "prj-b",
  projectName: "Project B",
};
const PROJECT_C: TrackerProjectInput = {
  serverId: "host-b",
  serverName: "Host B",
  projectId: "prj-c",
  projectName: "Project C",
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
  runtimeState.getClient.mockReturnValue({ trackerList, trackerSearch: vi.fn() });
  return trackerList;
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
    runtimeState.getClient.mockReturnValue({ trackerList, trackerSearch: vi.fn() });

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
    expect(result.current.sectionTotals.open).toBe(null);
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
    runtimeState.getClient.mockReturnValue({ trackerList, trackerSearch: vi.fn() });

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
    // The other three statuses were never requested at all — their totals
    // stay null (never-reported), the same degraded shape an offline
    // project or a fetch error produces, not zero.
    expect(result.current.sectionTotals.in_progress).toBeNull();
    expect(result.current.sectionTotals.closed).toBeNull();
    expect(result.current.sectionTotals.cancelled).toBeNull();
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
