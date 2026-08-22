/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TrackerStatsCounts } from "@getpaseo/protocol/tracker/rpc-schemas";
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

import { useTrackerStats } from "./use-tracker-stats";

const PROJECT_A: TrackerProjectInput = {
  serverId: "host-a",
  serverName: "Host A",
  projectId: "prj-a",
  projectName: "Project A",
};
const PROJECT_B: TrackerProjectInput = {
  serverId: "host-b",
  serverName: "Host B",
  projectId: "prj-b",
  projectName: "Project B",
};

function makeBucket(total: number): TrackerStatsCounts["all"] {
  return {
    total,
    byStatus: { open: total, in_progress: 0, closed: 0, cancelled: 0 },
    byPriority: { P0: 0, P1: 0, P2: total, P3: 0, P4: 0 },
  };
}

function makeCounts(total: number): TrackerStatsCounts {
  return {
    all: makeBucket(total),
    task: makeBucket(total),
    epic: makeBucket(0),
    initiative: makeBucket(0),
  };
}

/** Installs one client per serverId, each reporting `aitTrackerStats`
 * support and a canned `trackerStats` response (or throwing). */
function installClients(
  byServer: Record<string, { supportsStats: boolean; result?: TrackerStatsCounts | Error }>,
): void {
  runtimeState.getClient.mockImplementation((serverId: string) => {
    const entry = byServer[serverId];
    if (!entry) {
      return null;
    }
    return {
      getLastServerInfoMessage: () => ({
        features: { aitTrackerStats: entry.supportsStats },
      }),
      trackerStats: async () => {
        if (entry.result instanceof Error) {
          throw entry.result;
        }
        return {
          counts: entry.result ?? null,
          error: null,
          errorCode: null,
        };
      },
    };
  });
}

describe("useTrackerStats", () => {
  it("returns null while disabled and does not fetch", async () => {
    installClients({ "host-a": { supportsStats: true, result: makeCounts(5) } });
    const { result } = renderHook(() =>
      useTrackerStats({ projects: [PROJECT_A], selectedProjectId: null, enabled: false }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.counts).toBeNull();
  });

  it("sums counts across in-scope projects when every host supports the feature", async () => {
    installClients({
      "host-a": { supportsStats: true, result: makeCounts(5) },
      "host-b": { supportsStats: true, result: makeCounts(3) },
    });
    const { result } = renderHook(() =>
      useTrackerStats({
        projects: [PROJECT_A, PROJECT_B],
        selectedProjectId: null,
        enabled: true,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.counts?.all.total).toBe(8);
    expect(result.current.counts?.all.byStatus.open).toBe(8);
    expect(result.current.counts?.all.byPriority.P2).toBe(8);
  });

  it("returns null counts when any in-scope project's host lacks aitTrackerStats", async () => {
    installClients({
      "host-a": { supportsStats: true, result: makeCounts(5) },
      "host-b": { supportsStats: false },
    });
    const { result } = renderHook(() =>
      useTrackerStats({
        projects: [PROJECT_A, PROJECT_B],
        selectedProjectId: null,
        enabled: true,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.counts).toBeNull();
  });

  it("returns null counts when a project's stats RPC fails, and reports that project's error", async () => {
    installClients({
      "host-a": { supportsStats: true, result: makeCounts(5) },
      "host-b": { supportsStats: true, result: new Error("boom") },
    });
    const { result } = renderHook(() =>
      useTrackerStats({
        projects: [PROJECT_A, PROJECT_B],
        selectedProjectId: null,
        enabled: true,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.counts).toBeNull();
    expect(result.current.projectErrors).toEqual([
      {
        serverId: "host-b",
        serverName: "Host B",
        projectId: "prj-b",
        projectName: "Project B",
        message: "boom",
        code: "unknown",
      },
    ]);
  });

  it("keeps reporting counts for the projects that succeed alongside a failing one's error", async () => {
    installClients({
      "host-a": { supportsStats: true, result: makeCounts(5) },
      "host-b": { supportsStats: true, result: new Error("boom") },
    });
    const { result } = renderHook(() =>
      useTrackerStats({
        projects: [PROJECT_A, PROJECT_B],
        selectedProjectId: null,
        enabled: true,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // The summed total still poisons to null (same "any gap" rule as
    // sectionTotals) — but that must not stop prj-a's own fetch from
    // completing or the failure from being reported.
    expect(result.current.projectErrors).toHaveLength(1);
    expect(result.current.projectErrors[0]?.projectId).toBe("prj-b");
  });

  it("an offline project contributes neither a count nor a projectErrors entry", async () => {
    installClients({ "host-a": { supportsStats: true, result: makeCounts(5) } });
    // host-b has no entry at all — installClients' getClient returns null for
    // it, the same "offline" shape fetchTrackerPage already tolerates.
    const { result } = renderHook(() =>
      useTrackerStats({
        projects: [PROJECT_A, PROJECT_B],
        selectedProjectId: null,
        enabled: true,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.counts).toBeNull();
    expect(result.current.projectErrors).toEqual([]);
  });

  it("a host too old to advertise aitTrackerStats contributes neither a count nor an error", async () => {
    installClients({
      "host-a": { supportsStats: true, result: makeCounts(5) },
      "host-b": { supportsStats: false },
    });
    const { result } = renderHook(() =>
      useTrackerStats({
        projects: [PROJECT_A, PROJECT_B],
        selectedProjectId: null,
        enabled: true,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.counts).toBeNull();
    expect(result.current.projectErrors).toEqual([]);
  });

  it("scopes to the selected project only", async () => {
    installClients({
      "host-a": { supportsStats: true, result: makeCounts(5) },
      "host-b": { supportsStats: true, result: makeCounts(3) },
    });
    const { result } = renderHook(() =>
      useTrackerStats({
        projects: [PROJECT_A, PROJECT_B],
        selectedProjectId: "prj-a",
        enabled: true,
      }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.counts?.all.total).toBe(5);
  });

  it("discards a stale fetch after the scope changes mid-flight", async () => {
    let resolveStale: ((value: TrackerStatsCounts) => void) | null = null;
    const stalePromise = new Promise<TrackerStatsCounts>((resolve) => {
      resolveStale = resolve;
    });
    runtimeState.getClient.mockImplementation((serverId: string) => {
      if (serverId === "host-a") {
        return {
          getLastServerInfoMessage: () => ({ features: { aitTrackerStats: true } }),
          trackerStats: async () => {
            const counts = await stalePromise;
            return { counts, error: null, errorCode: null };
          },
        };
      }
      if (serverId === "host-b") {
        return {
          getLastServerInfoMessage: () => ({ features: { aitTrackerStats: true } }),
          trackerStats: async () => ({ counts: makeCounts(3), error: null, errorCode: null }),
        };
      }
      return null;
    });

    const { result, rerender } = renderHook(
      ({ selectedProjectId }: { selectedProjectId: string | null }) =>
        useTrackerStats({
          projects: [PROJECT_A, PROJECT_B],
          selectedProjectId,
          enabled: true,
        }),
      { initialProps: { selectedProjectId: "prj-a" } },
    );

    expect(result.current.isLoading).toBe(true);
    rerender({ selectedProjectId: "prj-b" });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.counts?.all.total).toBe(3);

    await act(async () => {
      resolveStale?.(makeCounts(5));
      await Promise.resolve();
      await Promise.resolve();
    });
    // The stale prj-a-scoped resolution must not overwrite prj-b's counts.
    expect(result.current.counts?.all.total).toBe(3);
  });
});
