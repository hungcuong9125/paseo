import type { IssueSummary } from "@getpaseo/protocol/issues/types";
import { describe, expect, it } from "vitest";
import {
  fetchAggregatedIssues,
  type IssueProjectInput,
  type IssuesRuntime,
  type IssuesRuntimeSnapshot,
} from "./aggregated-issues";
import { getIssueStatCounts } from "./issue-stats";

function makeIssue(overrides: Partial<IssueSummary> = {}): IssueSummary {
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

const PROJECT_A: IssueProjectInput = {
  serverId: "host-a",
  serverName: "Host A",
  projectId: "prj-a",
  projectName: "project-a",
};
const PROJECT_B: IssueProjectInput = {
  serverId: "host-b",
  serverName: "Host B",
  projectId: "prj-b",
  projectName: "project-b",
};

function makeRuntime(input: {
  snapshots: Record<string, IssuesRuntimeSnapshot | null>;
  results?: Record<string, { issues: IssueSummary[]; hiddenCount: number } | Error>;
}): IssuesRuntime {
  return {
    getSnapshot: (serverId) => input.snapshots[serverId] ?? null,
    getClient: (serverId) => {
      if (!(serverId in (input.results ?? {}))) {
        return null;
      }
      return {
        issuesList: async () => {
          const result = input.results?.[serverId];
          if (result instanceof Error) {
            throw result;
          }
          return result ?? { issues: [], hiddenCount: 0 };
        },
      };
    },
  };
}

describe("fetchAggregatedIssues load state", () => {
  it("does not report loaded empty while known projects' hosts are still connecting", async () => {
    const result = await fetchAggregatedIssues({
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

  it("reports loaded empty after every reachable project answers with no issues", async () => {
    const result = await fetchAggregatedIssues({
      projects: [PROJECT_A, PROJECT_B],
      all: false,
      runtime: makeRuntime({
        snapshots: {
          "host-a": { connectionStatus: "online" },
          "host-b": { connectionStatus: "online" },
        },
        results: {
          "host-a": { issues: [], hiddenCount: 0 },
          "host-b": { issues: [], hiddenCount: 0 },
        },
      }),
    });

    expect(result).toEqual({ status: "loaded", data: [], projectErrors: [] });
  });

  it("tags each issue with the project it came from", async () => {
    const issue = makeIssue();
    const result = await fetchAggregatedIssues({
      projects: [PROJECT_A],
      all: false,
      runtime: makeRuntime({
        snapshots: { "host-a": { connectionStatus: "online" } },
        results: { "host-a": { issues: [issue], hiddenCount: 0 } },
      }),
    });

    expect(result).toEqual({
      status: "loaded",
      data: [
        {
          ...issue,
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
    const projectBOnHostA: IssueProjectInput = {
      ...PROJECT_B,
      serverId: PROJECT_A.serverId,
    };
    const runtime: IssuesRuntime = {
      getSnapshot: () => ({ connectionStatus: "online" }),
      getClient: () => ({
        issuesList: async ({ projectId, all }) => {
          requests.push(`${projectId}:${String(all)}`);
          return {
            issues: [makeIssue({ id: `${projectId}-open-task` })],
            hiddenCount: 0,
          };
        },
      }),
    };

    const result = await fetchAggregatedIssues({
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
      throw new Error("Expected aggregated issues to be loaded");
    }
    expect(getIssueStatCounts(result.data)).toEqual({
      open: 2,
      inProgress: 0,
      p0: 0,
      done: 0,
      all: 2,
    });
  });

  it("collects a per-project error without dropping the other project's data", async () => {
    const issue = makeIssue();
    const result = await fetchAggregatedIssues({
      projects: [PROJECT_A, PROJECT_B],
      all: false,
      runtime: makeRuntime({
        snapshots: {
          "host-a": { connectionStatus: "online" },
          "host-b": { connectionStatus: "online" },
        },
        results: {
          "host-a": { issues: [issue], hiddenCount: 0 },
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
    const result = await fetchAggregatedIssues({
      projects: [PROJECT_A],
      all: false,
      runtime: makeRuntime({
        snapshots: { "host-a": { connectionStatus: "offline" } },
        results: { "host-a": { issues: [makeIssue()], hiddenCount: 0 } },
      }),
    });

    expect(result).toEqual({ status: "loaded", data: [], projectErrors: [] });
  });
});
