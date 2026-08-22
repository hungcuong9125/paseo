/**
 * @vitest-environment jsdom
 */
import { useEffect, useReducer } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TrackerStatsCounts } from "@getpaseo/protocol/tracker/rpc-schemas";
import type { TrackerProjectInput } from "@/tracker/aggregated-trackers";

const { runtimeState, sessionStoreState } = vi.hoisted(() => ({
  runtimeState: {
    getClient: vi.fn(),
    getSnapshot: vi.fn(() => ({ connectionStatus: "online" as const })),
  },
  sessionStoreState: {
    sessions: {} as Record<string, { serverInfo?: { features?: Record<string, boolean> } }>,
    listeners: new Set<() => void>(),
  },
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => runtimeState,
}));

// Minimal reactive stand-in for the real Zustand useSessionStore — re-renders
// the calling component whenever setSessionFeatureSupport below fires, the
// same reactivity the real store gives useTrackerStats' featureSupportKey
// selector (pas-2KY5X.1's fix).
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (
    selector: (state: { sessions: typeof sessionStoreState.sessions }) => unknown,
  ) => {
    const [, forceRender] = useReducer((c: number) => c + 1, 0);
    useEffect(() => {
      const listener = () => forceRender();
      sessionStoreState.listeners.add(listener);
      return () => {
        sessionStoreState.listeners.delete(listener);
      };
    }, []);
    return selector({ sessions: sessionStoreState.sessions });
  },
}));

function setSessionFeatureSupport(serverId: string, aitTrackerStats: boolean): void {
  sessionStoreState.sessions = {
    ...sessionStoreState.sessions,
    [serverId]: { serverInfo: { features: { aitTrackerStats } } },
  };
  for (const listener of sessionStoreState.listeners) {
    listener();
  }
}

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

  it("sums only the reporting project when one host lacks aitTrackerStats (pas-2KY5X.14)", async () => {
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
    expect(result.current.counts?.all.total).toBe(5);
  });

  it("sums only the succeeding project when another's stats RPC fails, and reports that project's error (pas-2KY5X.14)", async () => {
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
    // The failing project is treated as absent, not a poison — prj-a's count
    // still comes through alongside prj-b's error.
    expect(result.current.counts?.all.total).toBe(5);
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

  it("sums to a real zero when every in-scope project fails (pas-2KY5X.14)", async () => {
    installClients({
      "host-a": { supportsStats: true, result: new Error("boom") },
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
    // No project reported, but the scope wasn't poisoned — every gap is
    // "absent", so summing nothing is a real zero, not a blanked total.
    expect(result.current.counts?.all.total).toBe(0);
    expect(result.current.projectErrors).toHaveLength(1);
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
    expect(result.current.counts?.all.total).toBe(5);
    expect(result.current.projectErrors).toEqual([]);
  });

  it("poisons counts when the single selected project fails (pas-2KY5X.14)", async () => {
    installClients({
      "host-a": { supportsStats: true, result: new Error("boom") },
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
    // Scoped to exactly one project, so its failure is genuinely "no data" —
    // unlike the "all projects" scope above, this must stay null, not 0.
    expect(result.current.counts).toBeNull();
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

  it("a host that reports aitTrackerStats only after mount still produces counts (pas-2KY5X.1)", async () => {
    // host-a's server_info hasn't landed yet at mount — same shape as a host
    // still finishing its handshake, or a false read that arrived before
    // server_info did.
    setSessionFeatureSupport("host-a", false);
    runtimeState.getClient.mockImplementation((serverId: string) => {
      if (serverId !== "host-a") {
        return null;
      }
      return {
        // Reads the reactive fixture at call time — mirrors how the real
        // DaemonClient's cached server_info and the Zustand session store
        // are two views onto the same underlying fact.
        getLastServerInfoMessage: () => ({
          features: {
            aitTrackerStats:
              sessionStoreState.sessions["host-a"]?.serverInfo?.features?.aitTrackerStats === true,
          },
        }),
        trackerStats: async () => ({ counts: makeCounts(5), error: null, errorCode: null }),
      };
    });

    // Selected explicitly (rather than left as "all projects") so this still
    // exercises the poison-then-recover path after pas-2KY5X.14: with only
    // one project selected, an unreported flag must still block the total.
    const { result } = renderHook(() =>
      useTrackerStats({ projects: [PROJECT_A], selectedProjectId: "prj-a", enabled: true }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // Too early to read the feature — degrades exactly like an old daemon,
    // not stuck: a later flag flip must still recover.
    expect(result.current.counts).toBeNull();

    act(() => {
      setSessionFeatureSupport("host-a", true);
    });

    await waitFor(() => expect(result.current.counts).not.toBeNull());
    expect(result.current.counts?.all.total).toBe(5);
  });
});
