/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TrackerStatus, TrackerSummary } from "@getpaseo/protocol/tracker/types";
import type { TrackerProjectInput } from "@/tracker/aggregated-trackers";

const { runtimeState } = vi.hoisted(() => ({
  runtimeState: {
    getClient: vi.fn(),
    getSnapshot: vi.fn(() => ({ connectionStatus: "online" as const })),
  },
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => runtimeState,
}));

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
});
