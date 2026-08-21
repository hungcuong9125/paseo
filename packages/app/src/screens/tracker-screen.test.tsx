/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AggregatedTracker } from "@/tracker/aggregated-trackers";
import type { UseAggregatedTrackersResult } from "@/tracker/use-aggregated-trackers";
import type { ProjectHostEntry, ProjectSummary } from "@/utils/projects";
import type { UseProjectsResult } from "@/hooks/use-projects";

const { theme, projectsState, aggregatedState, lastKanbanBoardProps, lastListTableProps } =
  vi.hoisted(() => ({
    theme: {
      colors: {
        surface0: "#000",
        surface1: "#111",
        surface2: "#222",
        surface3: "#333",
        foreground: "#fff",
        foregroundMuted: "#aaa",
        border: "#444",
        palette: {
          blue: { 600: "#2563eb" },
          amber: { 700: "#b45309" },
          red: { 300: "#fca5a5", 600: "#dc2626" },
          green: { 600: "#16a34a" },
          orange: { 600: "#ea580c" },
          yellow: { 600: "#ca8a04" },
          sky: { 600: "#0284c7" },
          slate: { 400: "#94a3b8" },
        },
      },
      spacing: { 0: 0, 1: 4, "1.5": 6, 2: 8, 3: 12, 4: 16, 6: 24 },
      fontSize: { xs: 11, sm: 13, base: 15 },
      fontWeight: { normal: "400" as const, medium: "500" as const },
      borderRadius: { md: 6, lg: 8 },
      borderWidth: { 1: 1 },
      opacity: { 50: 0.5 },
      iconSize: { sm: 14, md: 20, lg: 32 },
    },
    projectsState: {
      current: {
        projects: [],
        hostErrors: [],
        isLoading: false,
        isFetching: false,
        refetch: vi.fn(),
      } as UseProjectsResult,
    },
    aggregatedState: {
      current: {
        loadState: { status: "loaded", data: [] },
        projectErrors: [],
        refetch: vi.fn(),
        isRefetching: false,
      } as UseAggregatedTrackersResult,
    },
    lastKanbanBoardProps: { current: null as { trackers: readonly unknown[] } | null },
    lastListTableProps: { current: null as { trackers: readonly unknown[] } | null },
  }));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  withUnistyles: <T,>(Component: T): T => Component,
  useUnistyles: () => ({ theme, rt: {}, breakpoint: undefined }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const templates: Record<string, string> = {
        "tracker.kanban.type.tasks": "Tasks",
        "tracker.kanban.type.epics": "Epics",
        "tracker.kanban.type.initiatives": "Initiatives",
        "tracker.kanban.type.all": "All",
      };
      return templates[key] ?? key;
    },
  }),
}));

vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  // The Ready-ids fetch (tracker-screen.tsx) goes through the real
  // useFetchQuery -> useQuery; it's disabled whenever there are no projects
  // (the default in this suite), so a static stub is enough — no test here
  // exercises the readyIds data itself.
  useQuery: () => ({ data: undefined, isPending: false, isFetching: false, refetch: vi.fn() }),
  useQueries: () => [],
  keepPreviousData: Symbol("keepPreviousData"),
  skipToken: Symbol("skipToken"),
}));

vi.mock("@/runtime/host-runtime", () => ({
  // Only reached by the readyIds queryFn, which the disabled query above never
  // invokes in this suite — stubbed purely so importing the module doesn't
  // pull in the real query-client singleton.
  getHostRuntimeStore: () => ({
    getClient: () => null,
    getSnapshot: () => null,
  }),
}));

vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => projectsState.current,
}));

vi.mock("@/tracker/use-aggregated-trackers", () => ({
  useAggregatedTrackers: () => aggregatedState.current,
}));

vi.mock("@/tracker/use-tracker-mutations", () => ({
  useTrackerMutations: () => ({
    initTracker: vi.fn(),
    isInitialising: false,
  }),
}));

vi.mock("@/hooks/use-open-add-project", () => ({
  useOpenAddProject: () => vi.fn(),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: { getState: () => ({ sessions: {} }) },
}));

vi.mock("@/components/headers/menu-header", () => ({
  MenuHeader: (props: { rightContent?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "menu-header" }, props.rightContent ?? null),
}));

vi.mock("@/components/tracker/tracker-detail-sheet", () => ({
  TrackerDetailSheet: () => null,
}));

vi.mock("@/components/tracker/tracker-form-sheet", () => ({
  TrackerFormSheet: () => null,
}));

vi.mock("@/components/tracker/tracker-table", () => ({
  TrackerTable: (props: { trackers: readonly unknown[] }) => {
    lastListTableProps.current = props;
    return React.createElement("div", { "data-testid": "mock-tracker-table" });
  },
}));

vi.mock("@/components/tracker/tracker-kanban-board", () => ({
  TrackerKanbanBoard: (props: { trackers: readonly unknown[] }) => {
    lastKanbanBoardProps.current = props;
    return React.createElement(
      "div",
      { "data-testid": "mock-kanban-board" },
      `count:${props.trackers.length}`,
    );
  },
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "dropdown-menu" }, children),
  DropdownMenuTrigger: ({
    children,
    testID,
  }: {
    children?: React.ReactNode | (() => React.ReactNode);
    testID?: string;
  }) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": testID },
      typeof children === "function" ? children() : children,
    ),
  DropdownMenuContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuItem: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuSeparator: () => null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    testID,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": testID, onClick: onPress },
      children,
    ),
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => null,
}));

interface MockSegmentOptionProps<T extends string> {
  option: { value: T; label: string; testID?: string };
  selected: boolean;
  onValueChange: (value: T) => void;
}

function MockSegmentOption<T extends string>({
  option,
  selected,
  onValueChange,
}: MockSegmentOptionProps<T>) {
  const handleClick = React.useCallback(
    () => onValueChange(option.value),
    [onValueChange, option.value],
  );
  return React.createElement(
    "button",
    {
      type: "button",
      "data-testid": option.testID,
      "aria-pressed": selected,
      onClick: handleClick,
    },
    option.label,
  );
}

// Mirrors the stand-in used by tracker-kanban-board.test.tsx: the real
// SegmentedControl reads theme.borderWidth/geometry tokens this fixture theme
// doesn't fully provide, so plain buttons exercise the same value/onValueChange
// contract without pulling in control-geometry.
vi.mock("@/components/ui/segmented-control", () => ({
  SegmentedControl: <T extends string>({
    options,
    value,
    onValueChange,
    testID,
  }: {
    options: Array<{ value: T; label: string; testID?: string }>;
    value: T;
    onValueChange: (value: T) => void;
    testID?: string;
  }) =>
    React.createElement(
      "div",
      { "data-testid": testID },
      options.map((option) => (
        <MockSegmentOption
          key={option.value}
          option={option}
          selected={option.value === value}
          onValueChange={onValueChange}
        />
      )),
    ),
}));

import { TrackerScreen } from "./tracker-screen";

function hostEntry(overrides: Partial<ProjectHostEntry> = {}): ProjectHostEntry {
  return {
    serverId: "host-a",
    projectId: "project-a",
    projectName: "Project",
    projectCustomName: null,
    serverName: "alpha",
    isOnline: true,
    repoRoot: "/home/me/proj",
    workspaceCount: 0,
    workspaces: [],
    ...overrides,
  };
}

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  const hosts = overrides.hosts ?? [hostEntry()];
  return {
    viewKey: "remote:github.com/acme/app",
    projectName: "acme/app",
    hosts,
    totalWorkspaceCount: 0,
    hostCount: hosts.length,
    onlineHostCount: hosts.length,
    ...overrides,
  };
}

function tracker(overrides: Partial<AggregatedTracker> = {}): AggregatedTracker {
  return {
    id: "t-1",
    title: "A tracker",
    type: "task",
    status: "open",
    priority: "P2",
    parentId: null,
    serverId: "host-a",
    serverName: "alpha",
    projectId: "project-a",
    projectName: "Project",
    ...overrides,
  };
}

function setProjectsState(overrides: Partial<UseProjectsResult>) {
  projectsState.current = {
    projects: [project()],
    hostErrors: [],
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

function setAggregatedState(overrides: Partial<UseAggregatedTrackersResult>) {
  aggregatedState.current = {
    loadState: { status: "loaded", data: [] },
    projectErrors: [],
    refetch: vi.fn(),
    isRefetching: false,
    ...overrides,
  };
}

describe("TrackerScreen kanban type filter", () => {
  let container: HTMLElement | null = null;
  let root: Root | null = null;

  const mixedTrackers: AggregatedTracker[] = [
    tracker({ id: "task-1", type: "task", title: "Task one" }),
    tracker({ id: "epic-1", type: "epic", title: "Epic one" }),
    tracker({ id: "initiative-1", type: "initiative", title: "Initiative one" }),
  ];

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setProjectsState({});
    setAggregatedState({ loadState: { status: "loaded", data: mixedTrackers } });
    lastKanbanBoardProps.current = null;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  function render() {
    act(() => {
      root?.render(React.createElement(TrackerScreen));
    });
  }

  function switchToKanban() {
    const kanbanToggle = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-view-kanban"]',
    );
    if (!kanbanToggle) throw new Error("Expected the Kanban view toggle to render");
    act(() => {
      kanbanToggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
  }

  it("renders the type filter control in List mode", () => {
    render();

    expect(container?.querySelector('[data-testid="trackers-type-filter"]')).not.toBeNull();
  });

  it("defaults to task-only trackers reaching the board on first Kanban render", () => {
    render();
    switchToKanban();

    expect(lastKanbanBoardProps.current?.trackers).toHaveLength(1);
    expect((lastKanbanBoardProps.current?.trackers[0] as AggregatedTracker | undefined)?.id).toBe(
      "task-1",
    );

    const control = container?.querySelector('[data-testid="trackers-type-filter"]');
    expect(control).not.toBeNull();
  });

  it("switching the type filter changes what's passed to the board", () => {
    render();
    switchToKanban();

    expect(lastKanbanBoardProps.current?.trackers).toHaveLength(1);

    const epicOption = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-type-filter-epic"]',
    );
    if (!epicOption) throw new Error("Expected the Epics filter option to render");
    act(() => {
      epicOption.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(lastKanbanBoardProps.current?.trackers).toHaveLength(1);
    expect((lastKanbanBoardProps.current?.trackers[0] as AggregatedTracker | undefined)?.id).toBe(
      "epic-1",
    );

    const allOption = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-type-filter-all"]',
    );
    if (!allOption) throw new Error("Expected the All filter option to render");
    act(() => {
      allOption.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(lastKanbanBoardProps.current?.trackers).toHaveLength(3);
  });

  it("type filter applies to the List view's tracker set", () => {
    render();

    const allOption = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-type-filter-all"]',
    );
    expect(allOption).not.toBeNull();

    const listTrackerIds = () =>
      (lastListTableProps.current?.trackers ?? []).map(
        (listTracker) => (listTracker as AggregatedTracker).id,
      );

    // Default shared state is "task" — the List set mirrors the board's default.
    expect(listTrackerIds()).toEqual(["task-1"]);

    const epicOption = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-type-filter-epic"]',
    );
    if (!epicOption) throw new Error("Expected the Epics filter option to render");
    act(() => {
      epicOption.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(listTrackerIds()).toEqual(["epic-1"]);

    act(() => {
      allOption?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    // Same project, so orderedTrackers sorts by id: epic-1 < initiative-1 < task-1.
    expect(listTrackerIds()).toEqual(["epic-1", "initiative-1", "task-1"]);
  });
});
