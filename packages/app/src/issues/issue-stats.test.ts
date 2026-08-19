import { describe, expect, it } from "vitest";
import type { AggregatedIssue } from "./aggregated-issues";
import { getIssueStatCounts } from "./issue-stats";

function issue(
  id: string,
  overrides: Pick<AggregatedIssue, "type" | "status" | "priority">,
): AggregatedIssue {
  const projectId = id.startsWith("a-") ? "project-a" : "project-b";
  return {
    id,
    title: id,
    parentId: null,
    serverId: projectId === "project-a" ? "host-a" : "host-b",
    serverName: projectId === "project-a" ? "Host A" : "Host B",
    projectId,
    projectName: projectId,
    ...overrides,
  };
}

describe("getIssueStatCounts", () => {
  it("counts tasks across projects without counting structural containers", () => {
    const issues = [
      issue("a-epic-open", { type: "epic", status: "open", priority: "P1" }),
      issue("a-task-open", { type: "task", status: "open", priority: "P0" }),
      issue("a-task-progress", { type: "task", status: "in_progress", priority: "P2" }),
      issue("a-task-closed", { type: "task", status: "closed", priority: "P0" }),
      issue("b-initiative-open", { type: "initiative", status: "open", priority: "P2" }),
      issue("b-epic-progress", { type: "epic", status: "in_progress", priority: "P0" }),
      issue("b-initiative-cancelled", {
        type: "initiative",
        status: "cancelled",
        priority: "P3",
      }),
      issue("b-task-cancelled", { type: "task", status: "cancelled", priority: "P4" }),
    ];

    expect(getIssueStatCounts(issues)).toEqual({
      open: 1,
      inProgress: 1,
      p0: 1,
      p1: 0,
      p2: 1,
      p3: 0,
      p4: 0,
      done: 2,
      all: 4,
    });
  });
});
