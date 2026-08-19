import { describe, expect, it } from "vitest";
import type {
  AggregateLoadState,
  AggregatedIssue,
  IssueProjectError,
} from "@/issues/use-aggregated-issues";
import { resolveIssuesScreenBodyState } from "./issues-screen-state";

const LOADED_EMPTY: AggregateLoadState<AggregatedIssue> = { status: "loaded", data: [] };

function projectError(overrides: Partial<IssueProjectError> = {}): IssueProjectError {
  return {
    serverId: "srv1",
    serverName: "Local",
    projectId: "prj1",
    projectName: "my-project",
    message: "boom",
    code: "unknown",
    ...overrides,
  };
}

describe("resolveIssuesScreenBodyState", () => {
  it("shows no-projects when the daemon has zero known projects", () => {
    expect(
      resolveIssuesScreenBodyState({
        hasAnyProject: false,
        loadState: LOADED_EMPTY,
        selectedProjectId: "all",
        projectErrors: [],
        visibleIssuesCount: 0,
      }),
    ).toEqual({ kind: "no-projects" });
  });

  it.each(["connecting", "loading"] as const)("shows loading while %s", (status) => {
    expect(
      resolveIssuesScreenBodyState({
        hasAnyProject: true,
        loadState: { status },
        selectedProjectId: "all",
        projectErrors: [],
        visibleIssuesCount: 0,
      }),
    ).toEqual({ kind: "loading" });
  });

  it("shows cli-missing for the selected project's own failure in single-project mode", () => {
    expect(
      resolveIssuesScreenBodyState({
        hasAnyProject: true,
        loadState: LOADED_EMPTY,
        selectedProjectId: "prj1",
        projectErrors: [projectError({ code: "cli_missing" })],
        visibleIssuesCount: 0,
      }),
    ).toEqual({ kind: "cli-missing" });
  });

  it("shows uninitialised for the selected project's own failure in single-project mode", () => {
    expect(
      resolveIssuesScreenBodyState({
        hasAnyProject: true,
        loadState: LOADED_EMPTY,
        selectedProjectId: "prj1",
        projectErrors: [projectError({ code: "uninitialised" })],
        visibleIssuesCount: 0,
      }),
    ).toEqual({ kind: "uninitialised" });
  });

  it("shows a generic load-error with message for other codes in single-project mode", () => {
    expect(
      resolveIssuesScreenBodyState({
        hasAnyProject: true,
        loadState: LOADED_EMPTY,
        selectedProjectId: "prj1",
        projectErrors: [projectError({ code: "unknown", message: "something else broke" })],
        visibleIssuesCount: 0,
      }),
    ).toEqual({ kind: "load-error", message: "something else broke" });
  });

  it("ignores a failure for a DIFFERENT project than the one selected", () => {
    expect(
      resolveIssuesScreenBodyState({
        hasAnyProject: true,
        loadState: LOADED_EMPTY,
        selectedProjectId: "prj1",
        projectErrors: [projectError({ projectId: "some-other-project", code: "cli_missing" })],
        visibleIssuesCount: 0,
      }),
    ).toEqual({ kind: "empty" });
  });

  it("in all-projects mode, a per-project failure never becomes a full-screen state", () => {
    expect(
      resolveIssuesScreenBodyState({
        hasAnyProject: true,
        loadState: LOADED_EMPTY,
        selectedProjectId: "all",
        projectErrors: [projectError({ code: "cli_missing" })],
        visibleIssuesCount: 0,
      }),
    ).toEqual({ kind: "empty" });
  });

  it("shows empty when loaded with zero visible issues", () => {
    expect(
      resolveIssuesScreenBodyState({
        hasAnyProject: true,
        loadState: LOADED_EMPTY,
        selectedProjectId: "all",
        projectErrors: [],
        visibleIssuesCount: 0,
      }),
    ).toEqual({ kind: "empty" });
  });

  it("shows content when loaded with at least one visible issue", () => {
    expect(
      resolveIssuesScreenBodyState({
        hasAnyProject: true,
        loadState: LOADED_EMPTY,
        selectedProjectId: "all",
        projectErrors: [],
        visibleIssuesCount: 1,
      }),
    ).toEqual({ kind: "content" });
  });
});
