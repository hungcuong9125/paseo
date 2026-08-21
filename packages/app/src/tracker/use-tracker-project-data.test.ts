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
  pageInfo?: { nextCursor: string | null; hasMore: boolean };
}

const EMPTY_PAGE: ListResponse = {
  trackers: [],
  hiddenCount: 0,
  pageInfo: { nextCursor: null, hasMore: false },
};

/** Installs a `trackerList` mock driven by a per-(projectId, status, cursor) response table. */
function installClient(
  responses: Record<string, ListResponse | (() => Promise<ListResponse>)>,
): void {
  const trackerList = vi.fn(
    async (args: { projectId: string; status?: TrackerStatus; page?: { cursor?: string } }) => {
      const key = `${args.projectId}:${args.status}:${args.page?.cursor ?? "start"}`;
      const entry = responses[key] ?? EMPTY_PAGE;
      return typeof entry === "function" ? entry() : entry;
    },
  );
  runtimeState.getClient.mockReturnValue({ trackerList, trackerSearch: vi.fn() });
}

describe("useTrackerProjectData", () => {
  it("loads the first page of every section then automatically sweeps until hasMore is false", async () => {
    installClient({
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
    // First page landed, but the sweep for the second page hasn't necessarily
    // resolved yet — isComplete tracks that separately from isLoading.
    expect(result.current.trackers.map((t) => t.id)).toContain("a-open-1");

    await waitFor(() => expect(result.current.isComplete).toBe(true));
    expect(result.current.trackers.map((t) => t.id).sort()).toEqual(["a-open-1", "a-open-2"]);
  });

  it("discards a stale background page instead of merging it after the scope changes mid-sweep", async () => {
    let resolveStalePage: ((value: ListResponse) => void) | null = null;
    const stalePagePromise = new Promise<ListResponse>((resolve) => {
      resolveStalePage = resolve;
    });

    installClient({
      // prj-a's open section has a second page, but it never resolves until
      // the test explicitly does so below — this simulates a background
      // sweep fetch that is still in flight when the scope changes.
      "prj-a:open:start": {
        trackers: [makeTracker("a-open-1")],
        hiddenCount: 0,
        pageInfo: { nextCursor: "1", hasMore: true },
      },
      "prj-a:open:1": () => stalePagePromise,
      // prj-b resolves immediately for every section.
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

    // Initial load for prj-a settles; the second page's fetch is in flight
    // (held open by stalePagePromise) as the background sweep for (prj-a, open).
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.trackers.map((t) => t.id)).toEqual(["a-open-1"]);
    expect(result.current.isComplete).toBe(false);

    // Scope change while that fetch is still pending — this must bump the
    // hook's internal sequence so the eventually-resolving stale page is
    // rejected rather than merged into prj-b's data.
    rerender({ selectedProjectId: "prj-b" });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await waitFor(() => expect(result.current.isComplete).toBe(true));
    expect(result.current.trackers.map((t) => t.id)).toEqual(["b-open-1"]);

    // Now let the stale prj-a fetch resolve — its result must never reach the
    // current (prj-b) state.
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
    expect(result.current.isComplete).toBe(true);
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
    await waitFor(() => expect(result.current.isComplete).toBe(true));
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
    await waitFor(() => expect(result.current.isComplete).toBe(true));
    expect(result.current.trackers).toHaveLength(2);

    act(() => {
      result.current.removeTrackers(["a-1"]);
    });
    expect(result.current.trackers.map((t) => t.id)).toEqual(["a-2"]);
  });
});
