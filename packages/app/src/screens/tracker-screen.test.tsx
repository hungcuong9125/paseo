/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackerStatsCounts } from "@getpaseo/protocol/tracker/rpc-schemas";
import type { TrackerStatus, TrackerSummary } from "@getpaseo/protocol/tracker/types";
import type {
  AggregatedTracker,
  TrackerProjectError,
  TrackerProjectInput,
} from "@/tracker/aggregated-trackers";
import type {
  UseTrackerProjectDataOptions,
  UseTrackerProjectDataResult,
} from "@/tracker/use-tracker-project-data";
import type { UseTrackerStatsResult } from "@/tracker/use-tracker-stats";
import type { ProjectHostEntry, ProjectSummary } from "@/utils/projects";
import type { UseProjectsResult } from "@/hooks/use-projects";

const {
  theme,
  hostsState,
  projectsState,
  projectDataState,
  statsState,
  lastProjectDataOptions,
  lastKanbanBoardProps,
  lastListTableProps,
  lastFormSheetProps,
  lastDetailSheetProps,
  sessionClient,
} = vi.hoisted(() => ({
  theme: {
    colorScheme: "light" as const,
    colors: {
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#444",
      accent: "#20744a",
      palette: {
        blue: { 600: "#2563eb" },
        amber: { 700: "#b45309" },
        red: { 300: "#fca5a5", 600: "#dc2626" },
        green: { 500: "#22c55e", 600: "#16a34a" },
        orange: { 600: "#ea580c" },
        yellow: { 600: "#ca8a04" },
        sky: { 600: "#0284c7" },
        slate: { 400: "#94a3b8" },
      },
    },
    spacing: { 0: 0, 1: 4, "1.5": 6, 2: 8, 3: 12, 4: 16, 6: 24 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400" as const, medium: "500" as const },
    fontFamily: { ui: "System", mono: "Menlo" },
    borderRadius: { sm: 4, md: 6, lg: 8, full: 999 },
    borderWidth: { 1: 1 },
    opacity: { 50: 0.5 },
    iconSize: { sm: 14, md: 20, lg: 32 },
  },
  hostsState: {
    current: [{ serverId: "srv1", label: "Local" }],
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
  projectDataState: {
    current: {
      trackers: [],
      sectionTotals: { open: null, in_progress: null, closed: null, cancelled: null },
      sectionHasMore: { open: false, in_progress: false, closed: false, cancelled: false },
      sectionLoadingMore: { open: false, in_progress: false, closed: false, cancelled: false },
      loadMore: vi.fn(),
      isLoading: false,
      projectErrors: [],
      patchTracker: vi.fn(),
      removeTrackers: vi.fn(),
      refetch: vi.fn(),
    } as UseTrackerProjectDataResult,
  },
  statsState: {
    current: {
      counts: null,
      isLoading: false,
      projectErrors: [],
      refetch: vi.fn(),
    } as UseTrackerStatsResult,
  },
  // The mock hook below filters `projectDataState.current.trackers` by
  // whichever options.type/priority the screen passed in (mirroring what the
  // real server-side scoping does) — captured here so tests can assert the
  // screen re-requests with new filter options instead of narrowing in
  // memory.
  lastProjectDataOptions: {
    current: null as UseTrackerProjectDataOptions | null,
  },
  lastKanbanBoardProps: {
    current: null as {
      trackers: readonly unknown[];
      laneTotals?: Partial<Record<string, number | null>>;
      onTransition: (trackerId: string, transition: unknown) => Promise<void>;
    } | null,
  },
  lastListTableProps: {
    current: null as {
      trackers: readonly unknown[];
      sectionTotals?: Record<TrackerStatus, number | null>;
      onLoadMore?: (status: TrackerStatus) => void;
      onTrackerPatched?: (tracker: AggregatedTracker) => void;
      onTrackersRemoved?: (ids: string[]) => void;
      onOpenTracker?: (tracker: AggregatedTracker) => void;
    } | null,
  },
  lastFormSheetProps: {
    current: null as {
      onCreated?: (tracker: TrackerSummary, project: TrackerProjectInput) => void;
    } | null,
  },
  lastDetailSheetProps: {
    current: null as { onMutated?: (tracker: TrackerSummary) => void } | null,
  },
  sessionClient: {
    trackerUpdate: vi.fn(),
    trackerClose: vi.fn(),
    trackerReopen: vi.fn(),
    trackerCancel: vi.fn(),
  },
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
  useHosts: () => hostsState.current,
}));

// One host, already hydrated: the screen reads these two to tell "no projects
// yet" apart from "this user has no projects", and every case in this suite is
// about a settled project list.
vi.mock("@/stores/session-store-hooks", () => ({
  useHydratedWorkspaceServerIds: (serverIds: readonly string[]) => [...serverIds],
}));

vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => projectsState.current,
}));

vi.mock("@/tracker/use-tracker-project-data", () => ({
  useTrackerProjectData: (options: UseTrackerProjectDataOptions) => {
    // The screen makes two calls: the primary one (this suite's pageSize
    // stub, 50) and the header bell's second, unscoped call at a fixed
    // pageSize of 1 — only the primary call's options are relevant here.
    if (options.pageSize !== 1) {
      lastProjectDataOptions.current = options;
    }
    const state = projectDataState.current;
    // Mirrors the real hook's server-side type/priority scoping: the
    // fixture's full tracker set narrows here, based on whatever options the
    // screen actually passed in — proof the screen no longer filters
    // in-memory itself.
    const trackers = state.trackers.filter(
      (candidate) =>
        (options.type === undefined || candidate.type === options.type) &&
        (options.priority === undefined || candidate.priority === options.priority),
    );
    return { ...state, trackers };
  },
}));

vi.mock("@/tracker/use-tracker-stats", () => ({
  // The screen calls this twice: the primary (picker-scoped) call and the
  // header bell's second, always-unscoped call. `statsState.current` holds
  // the full, unscoped fixture; scoping down to one project (mirroring the
  // real hook's own relevantProjects filter) happens here so both call sites
  // fall naturally out of the same fixture instead of needing to be told
  // apart.
  useTrackerStats: (options: { selectedProjectId: string | null }) => {
    const state = statsState.current;
    const projectErrors =
      options.selectedProjectId === null
        ? state.projectErrors
        : state.projectErrors.filter((error) => error.projectId === options.selectedProjectId);
    return { ...state, projectErrors };
  },
}));

vi.mock("@/tracker/use-tracker-search", () => ({
  useTrackerSearch: () => ({
    results: [],
    hasMore: false,
    isLoading: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
  }),
}));

vi.mock("@/tracker/use-tracker-mutations", () => ({
  useTrackerMutations: () => ({
    initTracker: vi.fn().mockResolvedValue({ initialised: true }),
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
  useSessionStore: { getState: () => ({ sessions: { "host-a": { client: sessionClient } } }) },
}));

vi.mock("@/utils/copy-to-clipboard", () => ({
  copyToClipboard: vi.fn(),
}));

vi.mock("@/components/headers/menu-header", () => ({
  MenuHeader: (props: { rightContent?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "menu-header" }, props.rightContent ?? null),
}));

vi.mock("@/components/tracker/tracker-detail-sheet", () => ({
  TrackerDetailSheet: (props: { onMutated?: (tracker: TrackerSummary) => void }) => {
    lastDetailSheetProps.current = props;
    return null;
  },
}));

vi.mock("@/components/tracker/tracker-form-sheet", () => ({
  TrackerFormSheet: (props: {
    onCreated?: (tracker: TrackerSummary, project: TrackerProjectInput) => void;
  }) => {
    lastFormSheetProps.current = props;
    return null;
  },
}));

// Same reason as the form/detail sheet mocks above: the real TrackerEditSheet
// pulls AdaptiveModalSheet → @gorhom/bottom-sheet/reanimated, which cannot load
// raw under this node-environment suite.
vi.mock("@/components/tracker/tracker-edit-sheet", () => ({
  TrackerEditSheet: () => null,
}));

vi.mock("@/components/tracker/tracker-table", () => ({
  TrackerTable: (props: {
    trackers: readonly unknown[];
    sectionTotals?: Record<TrackerStatus, number | null>;
    onLoadMore?: (status: TrackerStatus) => void;
    onTrackerPatched?: (tracker: AggregatedTracker) => void;
    onTrackersRemoved?: (ids: string[]) => void;
    onOpenTracker?: (tracker: AggregatedTracker) => void;
  }) => {
    lastListTableProps.current = props;
    return React.createElement("div", { "data-testid": "mock-tracker-table" });
  },
  useTrackerPageStep: () => 50,
}));

vi.mock("@/components/tracker/tracker-kanban-board", () => ({
  TrackerKanbanBoard: (props: {
    trackers: readonly unknown[];
    laneTotals?: Partial<Record<string, number | null>>;
    onTransition: (trackerId: string, transition: unknown) => Promise<void>;
  }) => {
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
    children?:
      | React.ReactNode
      | ((state: { pressed: boolean; hovered: boolean; open: boolean }) => React.ReactNode);
    testID?: string;
  }) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": testID },
      typeof children === "function"
        ? children({ pressed: false, hovered: false, open: false })
        : children,
    ),
  DropdownMenuContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    onSelect,
    testID,
  }: {
    children?: React.ReactNode;
    onSelect?: () => void;
    testID?: string;
  }) =>
    React.createElement(
      "div",
      { "data-testid": testID, role: "button", onClick: onSelect },
      children,
    ),
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

function setProjectDataState(overrides: Partial<UseTrackerProjectDataResult>) {
  projectDataState.current = {
    trackers: [],
    sectionTotals: { open: null, in_progress: null, closed: null, cancelled: null },
    sectionHasMore: { open: false, in_progress: false, closed: false, cancelled: false },
    sectionLoadingMore: { open: false, in_progress: false, closed: false, cancelled: false },
    loadMore: vi.fn(),
    isLoading: false,
    projectErrors: [],
    patchTracker: vi.fn(),
    removeTrackers: vi.fn(),
    refetch: vi.fn(),
    ...overrides,
  };
}

function setStatsState(overrides: Partial<UseTrackerStatsResult>) {
  statsState.current = {
    counts: null,
    isLoading: false,
    projectErrors: [],
    refetch: vi.fn(),
    ...overrides,
  };
}

function makeStatsBucket(total: number): TrackerStatsCounts["all"] {
  return {
    total,
    byStatus: { open: total, in_progress: 0, closed: 0, cancelled: 0 },
    byPriority: { P0: 0, P1: 0, P2: total, P3: 0, P4: 0 },
  };
}

describe("TrackerScreen kanban type filter", () => {
  let container: HTMLElement | null = null;
  let root: Root | null = null;

  // Pre-sorted (projectId then id), matching the invariant the real
  // useTrackerProjectData hook guarantees for its `trackers` output — the
  // mock stands in for the hook, not for its internal sort.
  const mixedTrackers: AggregatedTracker[] = [
    tracker({ id: "epic-1", type: "epic", title: "Epic one" }),
    tracker({ id: "initiative-1", type: "initiative", title: "Initiative one" }),
    tracker({ id: "task-1", type: "task", title: "Task one" }),
  ];

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setProjectsState({});
    setProjectDataState({ trackers: mixedTrackers });
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

  // The screen now defaults to Kanban — tests that exercise List-specific
  // rendering (TrackerTable props) must switch to it explicitly first.
  function switchToList() {
    const listToggle = container?.querySelector<HTMLElement>('[data-testid="trackers-view-list"]');
    if (!listToggle) throw new Error("Expected the List view toggle to render");
    act(() => {
      listToggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
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

  it("changing the type filter re-requests the shared hook with the new type instead of narrowing the loaded set in memory", () => {
    render();
    switchToKanban();

    // Default is "task" — passed straight through to the hook's options, not
    // applied as a client-side .filter() over an unfiltered fetch.
    expect(lastProjectDataOptions.current?.type).toBe("task");

    const epicOption = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-type-filter-epic"]',
    );
    if (!epicOption) throw new Error("Expected the Epics filter option to render");
    act(() => {
      epicOption.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(lastProjectDataOptions.current?.type).toBe("epic");

    const allOption = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-type-filter-all"]',
    );
    if (!allOption) throw new Error("Expected the All filter option to render");
    act(() => {
      allOption.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    // "all" means no type constraint at all — undefined, not the string "all".
    expect(lastProjectDataOptions.current?.type).toBeUndefined();
  });

  it("type filter applies to the List view's tracker set", () => {
    render();
    switchToList();

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

describe("TrackerScreen mutation patching", () => {
  let container: HTMLElement | null = null;
  let root: Root | null = null;

  const taskA: AggregatedTracker = tracker({ id: "task-1", type: "task", status: "open" });

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setProjectsState({});
    setProjectDataState({ trackers: [taskA] });
    lastKanbanBoardProps.current = null;
    lastListTableProps.current = null;
    lastFormSheetProps.current = null;
    lastDetailSheetProps.current = null;
    sessionClient.trackerClose.mockResolvedValue({ ...taskA, status: "closed" });
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

  // The screen now defaults to Kanban — tests that exercise List-specific
  // rendering (TrackerTable props) must switch to it explicitly first.
  function switchToList() {
    const listToggle = container?.querySelector<HTMLElement>('[data-testid="trackers-view-list"]');
    if (!listToggle) throw new Error("Expected the List view toggle to render");
    act(() => {
      listToggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
  }

  it("Show more calls the shared hook's loadMore instead of revealing already-loaded rows", () => {
    setProjectDataState({ trackers: [taskA] });
    render();
    switchToList();

    const onLoadMore = lastListTableProps.current?.onLoadMore;
    if (!onLoadMore) throw new Error("Expected TrackerTable to receive onLoadMore");
    act(() => {
      onLoadMore("open");
    });

    expect(projectDataState.current.loadMore).toHaveBeenCalledWith("open");
  });

  it("sums closed and cancelled into the Kanban Done lane's total", () => {
    setProjectDataState({
      trackers: [taskA],
      sectionTotals: { open: 4, in_progress: 1, closed: 3, cancelled: 2 },
    });
    render();
    switchToKanban();

    expect(lastKanbanBoardProps.current?.laneTotals?.done).toBe(5);
    expect(lastKanbanBoardProps.current?.laneTotals?.in_progress).toBe(1);
    expect(lastKanbanBoardProps.current?.laneTotals?.cancelled).toBe(2);
  });

  it("falls back the ready and open lanes to their loaded count instead of a status total", () => {
    // sectionTotals.open counts every open-status tracker (ready + blocked
    // together) — neither lane alone can be expressed from it, so both must
    // report null and let the column fall back to cards.length.
    setProjectDataState({
      trackers: [taskA],
      sectionTotals: { open: 9, in_progress: 0, closed: 0, cancelled: 0 },
    });
    render();
    switchToKanban();

    expect(lastKanbanBoardProps.current?.laneTotals?.ready).toBe(null);
    expect(lastKanbanBoardProps.current?.laneTotals?.open).toBe(null);
  });

  it("reads the toolbar stat pills from useTrackerStats and refreshes them after a mutation", async () => {
    setStatsState({
      counts: {
        all: makeStatsBucket(7),
        task: makeStatsBucket(7),
        epic: makeStatsBucket(0),
        initiative: makeStatsBucket(0),
      },
    });
    render();
    switchToKanban();

    const onTransition = lastKanbanBoardProps.current?.onTransition;
    if (!onTransition) throw new Error("Expected TrackerKanbanBoard to receive onTransition");
    await act(async () => {
      await onTransition("task-1", { kind: "close" });
    });

    expect(statsState.current.refetch).toHaveBeenCalled();
  });

  it("patches the shared hook with the transition's own response after a Kanban transition succeeds", async () => {
    render();
    switchToKanban();

    const onTransition = lastKanbanBoardProps.current?.onTransition;
    if (!onTransition) throw new Error("Expected TrackerKanbanBoard to receive onTransition");
    await act(async () => {
      await onTransition("task-1", { kind: "close" });
    });

    expect(sessionClient.trackerClose).toHaveBeenCalledWith({
      projectId: "project-a",
      trackerId: "task-1",
    });
    expect(projectDataState.current.patchTracker).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1", status: "closed" }),
    );
  });

  it("patches the shared hook when the create form reports a new tracker", () => {
    render();

    const onCreated = lastFormSheetProps.current?.onCreated;
    if (!onCreated) throw new Error("Expected TrackerFormSheet to receive onCreated");
    const created = tracker({ id: "task-2", type: "task", status: "open" });
    const createdProject: TrackerProjectInput = {
      serverId: "host-a",
      serverName: "alpha",
      projectId: "project-a",
      projectName: "Project",
    };
    act(() => {
      onCreated(created, createdProject);
    });

    expect(projectDataState.current.patchTracker).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-2", projectId: "project-a" }),
    );
  });

  it("patches the shared hook when the detail sheet reports a mutation", () => {
    render();
    switchToList();

    const onOpenTracker = lastListTableProps.current?.onOpenTracker;
    if (!onOpenTracker) throw new Error("Expected TrackerTable to receive onOpenTracker");
    act(() => {
      onOpenTracker(taskA);
    });

    const onMutated = lastDetailSheetProps.current?.onMutated;
    if (!onMutated) throw new Error("Expected TrackerDetailSheet to receive onMutated");
    act(() => {
      onMutated({ ...taskA, status: "in_progress" });
    });

    expect(projectDataState.current.patchTracker).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1", status: "in_progress" }),
    );
  });

  it("the bell reports an errored project's ait-init failure while a different project is selected in the toolbar", () => {
    const errorOnProjectB: TrackerProjectError = {
      serverId: "host-a",
      serverName: "alpha",
      projectId: "prj-b",
      projectName: "Project B",
      message: "No ait database",
      code: "uninitialised",
    };
    setProjectsState({
      projects: [
        project({ hosts: [hostEntry({ projectId: "prj-a", projectName: "Project A" })] }),
        project({
          viewKey: "remote:github.com/acme/other",
          projectName: "acme/other",
          hosts: [hostEntry({ projectId: "prj-b", projectName: "Project B" })],
        }),
      ],
    });
    // statsState.current.projectErrors is the full, unscoped fixture — the
    // mock scopes it down per useTrackerStats call the same way the real
    // hook does (see the mock above).
    setStatsState({ projectErrors: [errorOnProjectB] });
    render();

    const projectAOption = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-project-picker-prj-a"]',
    );
    if (!projectAOption) throw new Error("Expected the Project A picker option to render");
    act(() => {
      projectAOption.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    // The main (picker-scoped) stats call now only covers prj-a, so it
    // reports no errors of its own — but the bell's separate, always-unscoped
    // call still surfaces prj-b's failure.
    expect(
      container?.querySelector('[data-testid="trackers-project-errors-copy-host-a:prj-b"]'),
    ).not.toBeNull();
  });
});
