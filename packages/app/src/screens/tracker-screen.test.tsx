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
  // header bell's second call, scoped to every project except the picker's
  // (pas-2KY5X.8). `statsState.current` holds the full, unscoped fixture;
  // narrowing by both `options.projects` and `options.selectedProjectId`
  // (mirroring the real hook's own relevantProjects filter) happens here so
  // both call sites fall naturally out of the same fixture instead of
  // needing to be told apart.
  useTrackerStats: (options: {
    projects: readonly { projectId: string }[];
    selectedProjectId: string | null;
  }) => {
    const state = statsState.current;
    const inScopeProjects =
      options.selectedProjectId === null
        ? options.projects
        : options.projects.filter((p) => p.projectId === options.selectedProjectId);
    const inScopeProjectIds = new Set(inScopeProjects.map((p) => p.projectId));
    const projectErrors = state.projectErrors.filter((error) =>
      inScopeProjectIds.has(error.projectId),
    );
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
  useTrackerPageStep: () => 30,
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

  it("defaults to every type reaching the board on first Kanban render (pas-2KY5X.52)", () => {
    render();
    switchToKanban();

    expect(lastKanbanBoardProps.current?.trackers).toHaveLength(3);

    const control = container?.querySelector('[data-testid="trackers-type-filter"]');
    expect(control).not.toBeNull();
  });

  it("switching the type filter changes what's passed to the board", () => {
    render();
    switchToKanban();

    expect(lastKanbanBoardProps.current?.trackers).toHaveLength(3);

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

    // Default is "all" (pas-2KY5X.52) — no type constraint, passed straight
    // through to the hook's options as undefined, not applied as a
    // client-side .filter() over an unfiltered fetch.
    expect(lastProjectDataOptions.current?.type).toBeUndefined();

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

  it("fetches the same page step the Show-more label promises, 30 on desktop (pas-2KY5X.15)", () => {
    render();
    switchToKanban();

    // One number for the whole screen: useTrackerPageStep drives the fetch
    // budget, the label, and search alike, so a section can never load 30
    // rows under a button offering 50. Mocked to 30 above, matching
    // REVEAL_STEP_DESKTOP.
    expect(lastProjectDataOptions.current?.pageSize).toBe(30);
  });

  it("a List status filter reaches the query as options.sections instead of narrowing an all-four fetch in memory (pas-2KY5X.4)", () => {
    render();
    switchToList();

    // Unfiltered List means all four sections — undefined, matching the
    // hook's own "omitted = all four" default.
    expect(lastProjectDataOptions.current?.sections).toBeUndefined();

    const openPill = container?.querySelector<HTMLElement>('[data-testid="trackers-stat-open"]');
    if (!openPill) throw new Error("Expected the Open stat pill to render");
    act(() => {
      openPill.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(lastProjectDataOptions.current?.sections).toEqual(["open"]);

    const donePill = container?.querySelector<HTMLElement>('[data-testid="trackers-stat-done"]');
    if (!donePill) throw new Error("Expected the Done stat pill to render");
    act(() => {
      donePill.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    // "Done" maps to the closed section alone, per listVisibleStatusesForFilter.
    expect(lastProjectDataOptions.current?.sections).toEqual(["closed"]);

    // Switching to Kanban must not narrow the shared fetch even though the
    // List filter is still "done" underneath — Kanban renders all five
    // lanes from this one fetch.
    switchToKanban();
    expect(lastProjectDataOptions.current?.sections).toBeUndefined();
  });

  it("a Kanban priority filter reaches the query as options.priority instead of only dimming cards client-side (pas-2KY5X.10)", () => {
    render();
    switchToKanban();

    // Default type filter is "all" (pas-2KY5X.52) and priority is unfiltered
    // — every mixedTrackers item is P2, so all three reach the board.
    expect(lastProjectDataOptions.current?.priority).toBeUndefined();
    expect(lastKanbanBoardProps.current?.trackers).toHaveLength(3);

    const p2Button = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-kanban-priority-p2"]',
    );
    if (!p2Button) throw new Error("Expected the Kanban P2 priority filter button to render");
    act(() => {
      p2Button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(lastProjectDataOptions.current?.priority).toBe("P2");
    expect(lastKanbanBoardProps.current?.trackers).toHaveLength(3);

    const p1Button = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-kanban-priority-p1"]',
    );
    if (!p1Button) throw new Error("Expected the Kanban P1 priority filter button to render");
    act(() => {
      p1Button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(lastProjectDataOptions.current?.priority).toBe("P1");
    // None of mixedTrackers is P1 — the mock hook's server-side narrowing
    // (mirroring the real priority push) drops them all from the fetch
    // itself, proof this isn't still a client-side-only buildTrackerBoard dim.
    expect(lastKanbanBoardProps.current?.trackers).toHaveLength(0);

    const allButton = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-kanban-priority-all"]',
    );
    if (!allButton) throw new Error("Expected the Kanban All priority filter button to render");
    act(() => {
      allButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(lastProjectDataOptions.current?.priority).toBeUndefined();

    // Kanban's priority filter is independent state from List's — switching
    // view must not carry a leftover priority into the other view's query.
    switchToList();
    expect(lastProjectDataOptions.current?.priority).toBeUndefined();
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

    // Default shared state is "all" (pas-2KY5X.52) — sorted by id: epic-1 <
    // initiative-1 < task-1.
    expect(listTrackerIds()).toEqual(["epic-1", "initiative-1", "task-1"]);

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

describe("TrackerScreen filtered-empty state (pas-2KY5X.52)", () => {
  let container: HTMLElement | null = null;
  let root: Root | null = null;

  // The exact shape reported against the human's real databases
  // (tieuthuong-ai, paseo-demonthorn, digital_operating): open work exists,
  // but none of it is type "task".
  const epicOnlyTrackers: AggregatedTracker[] = [
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
    setProjectDataState({ trackers: epicOnlyTrackers });
    // statsCounts is what tells the screen the project isn't actually
    // empty — total 2 (one epic, one initiative), zero task, matching
    // epicOnlyTrackers exactly.
    setStatsState({
      counts: {
        all: makeStatsBucket(2),
        task: makeStatsBucket(0),
        epic: makeStatsBucket(1),
        initiative: makeStatsBucket(1),
      },
    });
    lastKanbanBoardProps.current = null;
    lastListTableProps.current = null;
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

  function switchToList() {
    const listToggle = container?.querySelector<HTMLElement>('[data-testid="trackers-view-list"]');
    if (!listToggle) throw new Error("Expected the List view toggle to render");
    act(() => {
      listToggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
  }

  function selectTaskTypeFilter() {
    const option = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-type-filter-task"]',
    );
    if (!option) throw new Error("Expected the Tasks type filter option to render");
    act(() => {
      option.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
  }

  it("defaults to type 'all', so a project whose work is entirely epic/initiative is visible on first Kanban render", () => {
    render();
    switchToKanban();

    expect(lastKanbanBoardProps.current?.trackers).toHaveLength(2);
    expect(container?.querySelector('[data-testid="trackers-filtered-empty"]')).toBeNull();
  });

  it("narrowing the type filter to zero matches shows the filtered-empty banner above the still-mounted board, in Kanban", () => {
    render();
    switchToKanban();
    selectTaskTypeFilter();

    // The board stays mounted with its own (empty) trackers — no full-screen
    // replacement, per the Kanban "no empty branch" design.
    expect(lastKanbanBoardProps.current?.trackers).toHaveLength(0);
    expect(container?.querySelector('[data-testid="mock-kanban-board"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="trackers-filtered-empty"]')).not.toBeNull();

    const clearButton = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-clear-filters"]',
    );
    if (!clearButton) throw new Error("Expected the Clear filters button to render");
    act(() => {
      clearButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(lastKanbanBoardProps.current?.trackers).toHaveLength(2);
    expect(container?.querySelector('[data-testid="trackers-filtered-empty"]')).toBeNull();
  });

  it("narrowing the type filter to zero matches shows the filtered-empty banner instead of the generic empty state, in List", () => {
    render();
    switchToList();
    selectTaskTypeFilter();

    expect(container?.querySelector('[data-testid="mock-tracker-table"]')).toBeNull();
    expect(container?.querySelector('[data-testid="trackers-filtered-empty"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="trackers-empty"]')).toBeNull();

    const clearButton = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-clear-filters"]',
    );
    if (!clearButton) throw new Error("Expected the Clear filters button to render");
    act(() => {
      clearButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(container?.querySelector('[data-testid="trackers-filtered-empty"]')).toBeNull();
  });

  it("does not claim filters hid anything while stats is still refetching after a mutation (pas-2KY5X.52 corrections pass)", () => {
    // Models the instant right after deleting the last visible tracker with
    // no filters active: projectData's local removal already emptied
    // trackers, but stats.refetch() (triggered by the same handler) hasn't
    // resolved yet, so statsCounts is still the pre-delete, nonzero total.
    // No filters are narrowing anything here — the two numbers just aren't
    // comparable yet, and the banner must not claim otherwise.
    setProjectDataState({ trackers: [] });
    setStatsState({
      counts: {
        all: makeStatsBucket(1),
        task: makeStatsBucket(1),
        epic: makeStatsBucket(0),
        initiative: makeStatsBucket(0),
      },
      isLoading: true,
    });
    render();
    switchToKanban();

    expect(container?.querySelector('[data-testid="trackers-filtered-empty"]')).toBeNull();

    switchToList();
    expect(container?.querySelector('[data-testid="trackers-filtered-empty"]')).toBeNull();
  });

  it("does not claim filters hid anything when a project's list RPC failed while its stats RPC succeeded, in all-projects mode (pas-2KY5X.52 corrections pass)", () => {
    // All-projects mode: a per-project project.tracker.list failure never
    // becomes a full-screen `blocked` state (that's a banner elsewhere, the
    // rest of the board still renders) — the visible set is empty for a
    // reason that has nothing to do with any filter, even though the
    // separate stats RPC for the same project succeeded with a real total.
    const listError: TrackerProjectError = {
      serverId: "host-a",
      serverName: "alpha",
      projectId: "project-a",
      projectName: "Project",
      message: "connection reset",
      code: "unknown",
    };
    setProjectDataState({ trackers: [], projectErrors: [listError] });
    setStatsState({
      counts: {
        all: makeStatsBucket(1),
        task: makeStatsBucket(1),
        epic: makeStatsBucket(0),
        initiative: makeStatsBucket(0),
      },
    });
    render();
    switchToKanban();

    expect(container?.querySelector('[data-testid="trackers-filtered-empty"]')).toBeNull();

    switchToList();
    expect(container?.querySelector('[data-testid="trackers-filtered-empty"]')).toBeNull();
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
    // statsState isn't reset by anything else here — without this, a test
    // that sets projectErrors (e.g. to exercise the bell or pas-2KY5X.17's
    // picker filter) leaks that into whichever test runs next and never
    // calls setStatsState itself.
    setStatsState({});
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

  it("the Kanban Done lane's total equals closed alone — cancelled is its own lane, not double-counted (pas-2KY5X.2)", () => {
    setProjectDataState({
      trackers: [taskA],
      sectionTotals: { open: 4, in_progress: 1, closed: 3, cancelled: 2 },
    });
    render();
    switchToKanban();

    expect(lastKanbanBoardProps.current?.laneTotals?.done).toBe(3);
    expect(lastKanbanBoardProps.current?.laneTotals?.cancelled).toBe(2);
    expect(lastKanbanBoardProps.current?.laneTotals?.in_progress).toBe(1);
    // laneForTracker in tracker-board-model.ts renders only closed-status
    // items in Done; summing in cancelled here would read 5 over 3 rows.
    expect(lastKanbanBoardProps.current?.laneTotals?.done).not.toBe(3 + 2);
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

  it("the List toolbar's Done pill counts closed alone, not closed+cancelled, matching the section header below it (pas-2KY5X.18)", () => {
    const bucket: TrackerStatsCounts["all"] = {
      total: 9,
      byStatus: { open: 0, in_progress: 0, closed: 3, cancelled: 2 },
      byPriority: { P0: 0, P1: 0, P2: 9, P3: 0, P4: 0 },
    };
    setStatsState({
      counts: { all: bucket, task: bucket, epic: bucket, initiative: bucket },
    });
    render();
    switchToList();

    const donePill = container?.querySelector<HTMLElement>('[data-testid="trackers-stat-done"]');
    if (!donePill) throw new Error("Expected the Done stat pill to render");
    // 3 (closed), never 5 (closed+cancelled) — clicking this pill only ever
    // surfaces closed rows (listVisibleStatusesForFilter("done") === ["closed"]
    // in tracker-stats.ts), so a count that included cancelled would disagree
    // with what selecting the pill actually shows, on top of disagreeing with
    // the section header's own closed-only total right below it.
    expect(donePill.textContent).toContain("3");
    expect(donePill.textContent).not.toContain("5");
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
      projectRootPath: "/repo/project-a",
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
    // A third, error-free project (prj-c) keeps the picker showing more than
    // one option after pas-2KY5X.17 hides prj-b from it — without it, the
    // picker itself wouldn't render at all (see the .17 test below), and
    // there'd be nothing to click to select prj-a through.
    setProjectsState({
      projects: [
        project({ hosts: [hostEntry({ projectId: "prj-a", projectName: "Project A" })] }),
        project({
          viewKey: "remote:github.com/acme/other",
          projectName: "acme/other",
          hosts: [hostEntry({ projectId: "prj-b", projectName: "Project B" })],
        }),
        project({
          viewKey: "remote:github.com/acme/third",
          projectName: "acme/third",
          hosts: [hostEntry({ projectId: "prj-c", projectName: "Project C" })],
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
    // reports no errors of its own — but the bell's separate call (scoped to
    // every project except prj-a) still surfaces prj-b's failure.
    expect(
      container?.querySelector('[data-testid="trackers-project-errors-copy-host-a:prj-b"]'),
    ).not.toBeNull();
  });

  it("the project picker never offers a project the bell has flagged as erroring (pas-2KY5X.17)", () => {
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
        project({
          viewKey: "remote:github.com/acme/third",
          projectName: "acme/third",
          hosts: [hostEntry({ projectId: "prj-c", projectName: "Project C" })],
        }),
      ],
    });
    setStatsState({ projectErrors: [errorOnProjectB] });
    render();

    expect(
      container?.querySelector('[data-testid="trackers-project-picker-prj-a"]'),
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="trackers-project-picker-prj-c"]'),
    ).not.toBeNull();
    expect(container?.querySelector('[data-testid="trackers-project-picker-prj-b"]')).toBeNull();
  });

  it("the project picker doesn't render at all once erroring projects leave only one selectable project (pas-2KY5X.17)", () => {
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
    setStatsState({ projectErrors: [errorOnProjectB] });
    render();

    // Same "only offer a picker when there's something to pick between" rule
    // the screen already applies to a genuinely single-project workspace —
    // once prj-b is filtered out, prj-a is the only project left, so the
    // trigger itself shouldn't render.
    expect(container?.querySelector('[data-testid="trackers-project-picker-trigger"]')).toBeNull();
  });

  it("the bell doesn't double-fetch or double-report the picker's own selected project (pas-2KY5X.8)", () => {
    const errorOnProjectA: TrackerProjectError = {
      serverId: "host-a",
      serverName: "alpha",
      projectId: "prj-a",
      projectName: "Project A",
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
    // Selected while healthy, then it starts erroring — pas-2KY5X.17 hides an
    // already-erroring project from the picker, so it can no longer be
    // selected there in the first place; this is the reachable version of
    // "the selected project is also the one erroring" (e.g. its ait database
    // disappears mid-session, after selection already happened).
    render();

    const projectAOption = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-project-picker-prj-a"]',
    );
    if (!projectAOption) throw new Error("Expected the Project A picker option to render");
    act(() => {
      projectAOption.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    setStatsState({ projectErrors: [errorOnProjectA] });
    render();

    // The bell's own call excludes prj-a (the picker already covers it), so
    // prj-a's error reaches the bell exactly once — via the picker-scoped
    // stats call — not duplicated by the bell's fan-out.
    const copyButtons = container?.querySelectorAll(
      '[data-testid="trackers-project-errors-copy-host-a:prj-a"]',
    );
    expect(copyButtons).toHaveLength(1);
  });

  // pas-2KY5X.28: aitInitialized === false is known upfront from the
  // descriptor, not discovered by a failed RPC — the fetch must exclude the
  // project before ever requesting anything from it, and the bell row must
  // still work without needing one either.
  it("a project with aitInitialized === false is excluded from the fetch, but still appears in the bell with a copy command built from projectRootPath directly (pas-2KY5X.28)", () => {
    setProjectsState({
      projects: [
        project({
          hosts: [
            hostEntry({
              projectId: "prj-a",
              projectName: "Project A",
              aitInitialized: true,
              repoRoot: "/repo/prj-a",
            }),
          ],
        }),
        project({
          viewKey: "remote:github.com/acme/other",
          projectName: "acme/other",
          hosts: [
            hostEntry({
              projectId: "prj-b",
              projectName: "Project B",
              aitInitialized: false,
              repoRoot: "/repo/prj-b",
            }),
          ],
        }),
      ],
    });
    render();

    // Excluded from the fetch — never sent to useTrackerProjectData at all,
    // so nothing was ever requested from it in the first place.
    expect(lastProjectDataOptions.current?.projects.map((p) => p.projectId)).toEqual(["prj-a"]);

    // Still shows up in the bell — statsState is untouched by this test
    // (default: no projectErrors), so this row can only have come from the
    // descriptor-derived gate, not an RPC failure.
    const copyButton = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-project-errors-copy-host-a:prj-b"]',
    );
    expect(copyButton).not.toBeNull();
    expect(copyButton?.textContent).toContain('cd "/repo/prj-b" && ait init');
  });

  it("a project with aitInitialized === true is not excluded from the fetch (pas-2KY5X.28)", () => {
    setProjectsState({
      projects: [
        project({
          hosts: [hostEntry({ projectId: "prj-a", aitInitialized: true, repoRoot: "/repo/prj-a" })],
        }),
      ],
    });
    render();

    expect(lastProjectDataOptions.current?.projects.map((p) => p.projectId)).toEqual(["prj-a"]);
  });

  it("a project whose aitInitialized is undefined (old daemon, or simply unknown) is not excluded — matches pre-.28 behavior exactly (pas-2KY5X.28)", () => {
    setProjectsState({
      projects: [
        // hostEntry()'s default omits aitInitialized entirely.
        project({ hosts: [hostEntry({ projectId: "prj-a", repoRoot: "/repo/prj-a" })] }),
      ],
    });
    render();

    expect(lastProjectDataOptions.current?.projects.map((p) => p.projectId)).toEqual(["prj-a"]);
  });

  // pas-2KY5X.28 follow-up (found by sweeping the tracker feature for what
  // the gate leaves stale): a project can still be *selected* after it drops
  // out of initializedProjectInputs — the picker already prevents selecting
  // an already-gated project (pas-2KY5X.17), but a project selected while
  // healthy/unknown and gated moments later (its descriptor catches up, or
  // its .ait/ait.db genuinely disappears) stays selected. Before this fix,
  // that state fell through to a bare "empty" screen with no explanation,
  // because projectData.projectErrors can never contain a project that was
  // never fetched in the first place.
  it("a selected project that becomes gated (aitInitialized flips to false) shows the Initialize tracker CTA instead of a bare empty screen", () => {
    setProjectsState({
      projects: [
        project({
          hosts: [
            hostEntry({ projectId: "prj-a", projectName: "Project A", aitInitialized: true }),
          ],
        }),
        project({
          viewKey: "remote:github.com/acme/other",
          projectName: "acme/other",
          hosts: [
            hostEntry({ projectId: "prj-b", projectName: "Project B", aitInitialized: true }),
          ],
        }),
      ],
    });
    render();

    const projectBOption = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-project-picker-prj-b"]',
    );
    if (!projectBOption) throw new Error("Expected the Project B picker option to render");
    act(() => {
      projectBOption.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    // Still selected, but its descriptor now reports no database.
    setProjectsState({
      projects: [
        project({
          hosts: [
            hostEntry({ projectId: "prj-a", projectName: "Project A", aitInitialized: true }),
          ],
        }),
        project({
          viewKey: "remote:github.com/acme/other",
          projectName: "acme/other",
          hosts: [
            hostEntry({ projectId: "prj-b", projectName: "Project B", aitInitialized: false }),
          ],
        }),
      ],
    });
    setProjectDataState({ trackers: [] });
    render();

    expect(container?.querySelector('[data-testid="trackers-initialise"]')).not.toBeNull();
  });

  it('the toolbar still shows the real project name (not "All projects") for a selected project that dropped out of the picker\'s own list', () => {
    // A third, unaffected project (prj-c) keeps the picker itself rendered
    // once prj-b is gated below — with only prj-a left, pas-2KY5X.17's own
    // "don't show a picker for a single selectable project" rule would hide
    // the trigger entirely, and there'd be nothing to read a label from.
    const threeProjects = [
      project({
        hosts: [hostEntry({ projectId: "prj-a", projectName: "Project A", aitInitialized: true })],
      }),
      project({
        viewKey: "remote:github.com/acme/other",
        projectName: "acme/other",
        hosts: [hostEntry({ projectId: "prj-b", projectName: "Project B", aitInitialized: true })],
      }),
      project({
        viewKey: "remote:github.com/acme/third",
        projectName: "acme/third",
        hosts: [hostEntry({ projectId: "prj-c", projectName: "Project C", aitInitialized: true })],
      }),
    ];
    setProjectsState({ projects: threeProjects });
    render();

    const projectBOption = container?.querySelector<HTMLElement>(
      '[data-testid="trackers-project-picker-prj-b"]',
    );
    if (!projectBOption) throw new Error("Expected the Project B picker option to render");
    act(() => {
      projectBOption.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    setProjectsState({
      projects: [
        threeProjects[0]!,
        project({
          viewKey: "remote:github.com/acme/other",
          projectName: "acme/other",
          hosts: [
            hostEntry({ projectId: "prj-b", projectName: "Project B", aitInitialized: false }),
          ],
        }),
        threeProjects[2]!,
      ],
    });
    render();

    const trigger = container?.querySelector('[data-testid="trackers-project-picker-trigger"]');
    expect(trigger?.textContent).toBe("Project B");
    expect(trigger?.textContent).not.toBe("All projects");
  });
});
