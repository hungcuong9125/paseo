import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";
import { describe, expect, it } from "vitest";
import {
  fetchAggregatedTrackers,
  type TrackerProjectInput,
  type TrackersRuntime,
  type TrackersRuntimeSnapshot,
} from "./aggregated-trackers";
import { getTrackerStatCounts } from "./tracker-stats";

function makeTracker(overrides: Partial<TrackerSummary> = {}): TrackerSummary {
  return {
    id: "proj-1",
    title: "Fix the thing",
    type: "task",
    status: "open",
    priority: "P2",
    parentId: null,
    ...overrides,
  };
}

const PROJECT_A: TrackerProjectInput = {
  serverId: "host-a",
  serverName: "Host A",
  projectId: "prj-a",
  projectName: "project-a",
};
const PROJECT_B: TrackerProjectInput = {
  serverId: "host-b",
  serverName: "Host B",
  projectId: "prj-b",
  projectName: "project-b",
};

function makeRuntime(input: {
  snapshots: Record<string, TrackersRuntimeSnapshot | null>;
  results?: Record<string, { trackers: TrackerSummary[]; hiddenCount: number } | Error>;
}): TrackersRuntime {
  return {
    getSnapshot: (serverId) => input.snapshots[serverId] ?? null,
    getClient: (serverId) => {
      if (!(serverId in (input.results ?? {}))) {
        return null;
      }
      return {
        trackerList: async () => {
          const result = input.results?.[serverId];
          if (result instanceof Error) {
            throw result;
          }
          return result ?? { trackers: [], hiddenCount: 0 };
        },
        trackerSearch: async () => {
          throw new Error("trackerSearch is not expected in fetchAggregatedTrackers tests");
        },
      };
    },
  };
}

describe("fetchAggregatedTrackers load state", () => {
  it("does not report loaded empty while known projects' hosts are still connecting", async () => {
    const result = await fetchAggregatedTrackers({
      projects: [PROJECT_A, PROJECT_B],
      all: false,
      runtime: makeRuntime({
        snapshots: {
          "host-a": { connectionStatus: "connecting" },
          "host-b": { connectionStatus: "connecting" },
        },
      }),
    });

    expect(result).toEqual({ status: "connecting" });
  });

  it("reports loaded empty after every reachable project answers with no trackers", async () => {
    const result = await fetchAggregatedTrackers({
      projects: [PROJECT_A, PROJECT_B],
      all: false,
      runtime: makeRuntime({
        snapshots: {
          "host-a": { connectionStatus: "online" },
          "host-b": { connectionStatus: "online" },
        },
        results: {
          "host-a": { trackers: [], hiddenCount: 0 },
          "host-b": { trackers: [], hiddenCount: 0 },
        },
      }),
    });

    expect(result).toEqual({ status: "loaded", data: [], projectErrors: [] });
  });

  it("tags each tracker with the project it came from", async () => {
    const tracker = makeTracker();
    const result = await fetchAggregatedTrackers({
      projects: [PROJECT_A],
      all: false,
      runtime: makeRuntime({
        snapshots: { "host-a": { connectionStatus: "online" } },
        results: { "host-a": { trackers: [tracker], hiddenCount: 0 } },
      }),
    });

    expect(result).toEqual({
      status: "loaded",
      data: [
        {
          ...tracker,
          serverId: "host-a",
          serverName: "Host A",
          projectId: "prj-a",
          projectName: "project-a",
        },
      ],
      projectErrors: [],
    });
  });

  it("fetches every project on one host with all statuses enabled", async () => {
    const requests: string[] = [];
    const projectBOnHostA: TrackerProjectInput = {
      ...PROJECT_B,
      serverId: PROJECT_A.serverId,
    };
    const runtime: TrackersRuntime = {
      getSnapshot: () => ({ connectionStatus: "online" }),
      getClient: () => ({
        trackerList: async ({ projectId, all }) => {
          requests.push(`${projectId}:${String(all)}`);
          return {
            trackers: [makeTracker({ id: `${projectId}-open-task` })],
            hiddenCount: 0,
          };
        },
        trackerSearch: async () => {
          throw new Error("trackerSearch is not expected in fetchAggregatedTrackers tests");
        },
      }),
    };

    const result = await fetchAggregatedTrackers({
      projects: [PROJECT_A, projectBOnHostA],
      all: true,
      runtime,
    });

    expect(requests.sort()).toEqual(["prj-a:true", "prj-b:true"]);
    expect(result).toMatchObject({
      status: "loaded",
      data: [
        { id: "prj-a-open-task", projectId: "prj-a", status: "open", type: "task" },
        { id: "prj-b-open-task", projectId: "prj-b", status: "open", type: "task" },
      ],
      projectErrors: [],
    });
    if (result.status !== "loaded") {
      throw new Error("Expected aggregated trackers to be loaded");
    }
    expect(getTrackerStatCounts(result.data)).toEqual({
      open: 2,
      inProgress: 0,
      p0: 0,
      p1: 0,
      p2: 2,
      p3: 0,
      p4: 0,
      done: 0,
      all: 2,
    });
  });

  it("collects a per-project error without dropping the other project's data", async () => {
    const tracker = makeTracker();
    const result = await fetchAggregatedTrackers({
      projects: [PROJECT_A, PROJECT_B],
      all: false,
      runtime: makeRuntime({
        snapshots: {
          "host-a": { connectionStatus: "online" },
          "host-b": { connectionStatus: "online" },
        },
        results: {
          "host-a": { trackers: [tracker], hiddenCount: 0 },
          "host-b": new Error("boom"),
        },
      }),
    });

    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") {
      throw new Error("unreachable");
    }
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.projectId).toBe("prj-a");
    expect(result.projectErrors).toEqual([
      {
        serverId: "host-b",
        serverName: "Host B",
        projectId: "prj-b",
        projectName: "project-b",
        message: "boom",
        code: "unknown",
      },
    ]);
  });

  it("skips a project whose host is offline", async () => {
    const result = await fetchAggregatedTrackers({
      projects: [PROJECT_A],
      all: false,
      runtime: makeRuntime({
        snapshots: { "host-a": { connectionStatus: "offline" } },
        results: { "host-a": { trackers: [makeTracker()], hiddenCount: 0 } },
      }),
    });

    expect(result).toEqual({ status: "loaded", data: [], projectErrors: [] });
  });
});
