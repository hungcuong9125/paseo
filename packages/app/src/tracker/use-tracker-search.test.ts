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

function makeTracker(id: string): TrackerSummary {
  return {
    id,
    title: `Tracker ${id}`,
    type: "task",
    status: "open",
    priority: "P2",
    parentId: null,
  };
}

describe("useTrackerSearch", () => {
  it("keeps an initial project error visible while another project loads more", async () => {
    runtimeState.getClient.mockReturnValue({
      trackerSearch: vi.fn(async (args: { projectId: string; page?: { cursor?: string } }) => {
        if (args.projectId === PROJECT_A.projectId) throw new Error("Project A unavailable");
        if (args.page?.cursor)
          return { trackers: [makeTracker("b2")], pageInfo: { nextCursor: null, hasMore: false } };
        return { trackers: [makeTracker("b1")], pageInfo: { nextCursor: "next", hasMore: true } };
      }),
    });
    const { result, unmount } = renderHook(() =>
      useTrackerSearch({
        projects: [PROJECT_A, PROJECT_B],
        selectedProjectId: null,
        query: "search",
        enabled: true,
        pageSize: 1,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.projectErrors.map((error) => error.projectId)).toEqual([
      PROJECT_A.projectId,
    ]);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.isLoadingMore).toBe(false));
    expect(result.current.results.map((row) => row.id)).toEqual(["b1", "b2"]);
    expect(result.current.projectErrors.map((error) => error.projectId)).toEqual([
      PROJECT_A.projectId,
    ]);
    unmount();
  });
  it("releases load-more state when a new search supersedes its pending page", async () => {
    const pending = Promise.withResolvers<{
      trackers: TrackerSummary[];
      pageInfo: { nextCursor: null; hasMore: false };
    }>();
    const trackerSearch = vi.fn(async (args: { query: string; page?: { cursor?: string } }) => {
      if (args.page?.cursor) return pending.promise;
      return {
        trackers: [makeTracker(args.query)],
        pageInfo: { nextCursor: "next", hasMore: true },
      };
    });
    runtimeState.getClient.mockReturnValue({ trackerSearch });
    const { result, rerender, unmount } = renderHook(
      ({ query }) =>
        useTrackerSearch({
          projects: [PROJECT_A],
          selectedProjectId: null,
          query,
          enabled: true,
          pageSize: 1,
        }),
      { initialProps: { query: "first" } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.loadMore());
    expect(result.current.isLoadingMore).toBe(true);
    rerender({ query: "second" });
    await waitFor(() => expect(result.current.results[0]?.id).toBe("second"));
    expect(result.current.isLoadingMore).toBe(false);
    await act(async () =>
      pending.resolve({
        trackers: [makeTracker("stale")],
        pageInfo: { nextCursor: null, hasMore: false },
      }),
    );
    expect(result.current.results.map((tracker) => tracker.id)).toEqual(["second"]);
    unmount();
  });
  it("surfaces a later-page failure and keeps that cursor available for retry", async () => {
    const trackerSearch = vi.fn(async (args: { projectId: string; page?: { cursor?: string } }) => {
      const cursor = args.page?.cursor;
      if (args.projectId === "prj-a" && cursor === undefined) {
        return {
          trackers: [makeTracker("a-1")],
          pageInfo: { nextCursor: "a-next", hasMore: true },
        };
      }
      if (args.projectId === "prj-a" && cursor === "a-next") {
        throw new Error("project A search failed");
      }
      if (args.projectId === "prj-b" && cursor === undefined) {
        return {
          trackers: [makeTracker("b-1")],
          pageInfo: { nextCursor: "b-next", hasMore: true },
        };
      }
      if (args.projectId === "prj-b" && cursor === "b-next") {
        return {
          trackers: [makeTracker("b-2")],
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

    expect(result.current.results.map((tracker) => tracker.id)).toEqual(["a-1", "b-1", "b-2"]);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.projectErrors).toEqual([
      expect.objectContaining({ projectId: "prj-a", message: "project A search failed" }),
    ]);
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
    expect(trackerSearch).toHaveBeenCalledTimes(5);
  });
});
