/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";
import type { TrackerProjectInput } from "./aggregated-trackers";

const { runtimeState } = vi.hoisted(() => ({
  runtimeState: {
    getClient: vi.fn(),
    getSnapshot: vi.fn(() => ({ connectionStatus: "online" as const })),
  },
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => runtimeState,
}));

import { useTrackerSearch } from "./use-tracker-search";

const PROJECT_A: TrackerProjectInput = {
  serverId: "host-a",
  serverName: "Host A",
  projectId: "prj-a",
  projectName: "Project A",
  projectRootPath: "/repo/prj-a",
};
const PROJECT_B: TrackerProjectInput = {
  serverId: "host-b",
  serverName: "Host B",
  projectId: "prj-b",
  projectName: "Project B",
  projectRootPath: "/repo/prj-b",
};

function makeTracker(id: string, createdAt?: string): TrackerSummary {
  return {
    id,
    title: `Tracker ${id}`,
    type: "task",
    status: "open",
    priority: "P2",
    parentId: null,
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

describe("useTrackerSearch", () => {
  it("orders merged results newest-first across projects, not by projectId then id (pas-2KY5X.39)", async () => {
    // "prj-a" sorts before "prj-b" alphabetically, but a-1 is the OLDER
    // tracker — the old projectId-then-id comparator would put a-1 first
    // regardless of recency, exactly the defect 125d7ed59 fixed for browse
    // but never for search.
    const trackerSearch = vi.fn(async (args: { projectId: string }) => {
      if (args.projectId === "prj-a") {
        return {
          trackers: [makeTracker("a-1", "2026-01-01T00:00:00Z")],
          pageInfo: { nextCursor: null, hasMore: false },
        };
      }
      if (args.projectId === "prj-b") {
        return {
          trackers: [makeTracker("b-1", "2026-06-01T00:00:00Z")],
          pageInfo: { nextCursor: null, hasMore: false },
        };
      }
      throw new Error(`unexpected search request: ${args.projectId}`);
    });
    runtimeState.getClient.mockReturnValue({ trackerSearch });

    const { result } = renderHook(() =>
      useTrackerSearch({
        projects: [PROJECT_A, PROJECT_B],
        selectedProjectId: null,
        query: "find me",
        enabled: true,
        pageSize: 10,
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.results.map((tracker) => tracker.id)).toEqual(["b-1", "a-1"]);
  });

  it("stops offering more when one project's later page fails", async () => {
    const trackerSearch = vi.fn(async (args: { projectId: string; page?: { cursor?: string } }) => {
      const cursor = args.page?.cursor;
      if (args.projectId === "prj-a" && cursor === undefined) {
        return {
          trackers: [makeTracker("a-1", "2026-01-01T00:00:00Z")],
          pageInfo: { nextCursor: "a-next", hasMore: true },
        };
      }
      if (args.projectId === "prj-a" && cursor === "a-next") {
        throw new Error("project A search failed");
      }
      if (args.projectId === "prj-b" && cursor === undefined) {
        return {
          trackers: [makeTracker("b-1", "2026-02-01T00:00:00Z")],
          pageInfo: { nextCursor: "b-next", hasMore: true },
        };
      }
      if (args.projectId === "prj-b" && cursor === "b-next") {
        return {
          trackers: [makeTracker("b-2", "2026-03-01T00:00:00Z")],
          pageInfo: { nextCursor: null, hasMore: false },
        };
      }
      throw new Error(`unexpected search request: ${args.projectId}:${cursor}`);
    });
    runtimeState.getClient.mockReturnValue({ trackerSearch });

    const { result } = renderHook(() =>
      useTrackerSearch({
        projects: [PROJECT_A, PROJECT_B],
        selectedProjectId: null,
        query: "find me",
        enabled: true,
        pageSize: 1,
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasMore).toBe(true);

    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.isLoadingMore).toBe(false));

    // Newest-first (compareByCreatedNewest), not projectId-then-id: b-2
    // (2026-03) is newest, a-1 (2026-01) is oldest.
    expect(result.current.results.map((tracker) => tracker.id)).toEqual(["b-2", "b-1", "a-1"]);
    expect(result.current.hasMore).toBe(false);
    expect(trackerSearch.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            projectId: "prj-a",
            page: expect.objectContaining({ limit: 1 }),
          }),
        ],
        [
          expect.objectContaining({
            projectId: "prj-b",
            page: expect.objectContaining({ limit: 1 }),
          }),
        ],
        [
          expect.objectContaining({
            projectId: "prj-a",
            page: expect.objectContaining({ cursor: "a-next", limit: 1 }),
          }),
        ],
        [
          expect.objectContaining({
            projectId: "prj-b",
            page: expect.objectContaining({ cursor: "b-next", limit: 1 }),
          }),
        ],
      ]),
    );

    act(() => {
      result.current.loadMore();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(trackerSearch).toHaveBeenCalledTimes(4);
  });
});
