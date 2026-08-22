import { describe, expect, it } from "vitest";
import type { TrackerProjectError } from "@/tracker/aggregated-trackers";
import { resolveTrackerScreenBodyState } from "./tracker-screen-state";

function projectError(overrides: Partial<TrackerProjectError> = {}): TrackerProjectError {
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

describe("resolveTrackerScreenBodyState", () => {
  it("shows no-projects when the daemon has zero known projects", () => {
    expect(
      resolveTrackerScreenBodyState({
        hasAnyProject: false,
        isProjectListLoading: false,
        isLoading: false,
        selectedProjectId: "all",
        projectErrors: [],
        visibleTrackersCount: 0,
      }),
    ).toEqual({ kind: "no-projects" });
  });

  it("shows loading, not no-projects, while the project list is still being fetched", () => {
    expect(
      resolveTrackerScreenBodyState({
        hasAnyProject: false,
        isProjectListLoading: true,
        isLoading: false,
        selectedProjectId: "all",
        projectErrors: [],
        visibleTrackersCount: 0,
      }),
    ).toEqual({ kind: "loading" });
  });

  it("shows loading while the shared project-data hook is still loading", () => {
    expect(
      resolveTrackerScreenBodyState({
        hasAnyProject: true,
        isProjectListLoading: false,
        isLoading: true,
        selectedProjectId: "all",
        projectErrors: [],
        visibleTrackersCount: 0,
      }),
    ).toEqual({ kind: "loading" });
  });

  it("shows cli-missing for the selected project's own failure in single-project mode", () => {
    expect(
      resolveTrackerScreenBodyState({
        hasAnyProject: true,
        isProjectListLoading: false,
        isLoading: false,
        selectedProjectId: "prj1",
        projectErrors: [projectError({ code: "cli_missing" })],
        visibleTrackersCount: 0,
      }),
    ).toEqual({ kind: "cli-missing" });
  });

  it("shows uninitialised for the selected project's own failure in single-project mode", () => {
    expect(
      resolveTrackerScreenBodyState({
        hasAnyProject: true,
        isProjectListLoading: false,
        isLoading: false,
        selectedProjectId: "prj1",
        projectErrors: [projectError({ code: "uninitialised" })],
        visibleTrackersCount: 0,
      }),
    ).toEqual({ kind: "uninitialised" });
  });

  it("shows a generic load-error with message for other codes in single-project mode", () => {
    expect(
      resolveTrackerScreenBodyState({
        hasAnyProject: true,
        isProjectListLoading: false,
        isLoading: false,
        selectedProjectId: "prj1",
        projectErrors: [projectError({ code: "unknown", message: "something else broke" })],
        visibleTrackersCount: 0,
      }),
    ).toEqual({ kind: "load-error", message: "something else broke" });
  });

  it("ignores a failure for a DIFFERENT project than the one selected", () => {
    expect(
      resolveTrackerScreenBodyState({
        hasAnyProject: true,
        isProjectListLoading: false,
        isLoading: false,
        selectedProjectId: "prj1",
        projectErrors: [projectError({ projectId: "some-other-project", code: "cli_missing" })],
        visibleTrackersCount: 0,
      }),
    ).toEqual({ kind: "empty" });
  });

  it("in all-projects mode, a per-project failure never becomes a full-screen state", () => {
    expect(
      resolveTrackerScreenBodyState({
        hasAnyProject: true,
        isProjectListLoading: false,
        isLoading: false,
        selectedProjectId: "all",
        projectErrors: [projectError({ code: "cli_missing" })],
        visibleTrackersCount: 0,
      }),
    ).toEqual({ kind: "empty" });
  });

  it("shows empty when loaded with zero visible trackers", () => {
    expect(
      resolveTrackerScreenBodyState({
        hasAnyProject: true,
        isProjectListLoading: false,
        isLoading: false,
        selectedProjectId: "all",
        projectErrors: [],
        visibleTrackersCount: 0,
      }),
    ).toEqual({ kind: "empty" });
  });

  it("shows content when loaded with at least one visible tracker", () => {
    expect(
      resolveTrackerScreenBodyState({
        hasAnyProject: true,
        isProjectListLoading: false,
        isLoading: false,
        selectedProjectId: "all",
        projectErrors: [],
        visibleTrackersCount: 1,
      }),
    ).toEqual({ kind: "content" });
  });
});
