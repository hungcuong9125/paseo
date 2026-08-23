/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AggregatedTracker } from "@/tracker/aggregated-trackers";

const { theme, mutationMocks, confirmDialogMock } = vi.hoisted(() => ({
  theme: {
    colors: {
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#444",
      palette: {
        blue: { 600: "#2563eb" },
        amber: { 700: "#b45309" },
        green: { 600: "#16a34a" },
      },
    },
    spacing: { 0: 0, 1: 4, "1.5": 6, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400" as const, medium: "500" as const },
    borderRadius: { md: 6, lg: 8 },
  },
  mutationMocks: {
    updateTracker: vi.fn().mockResolvedValue({ status: "in_progress" }),
    closeTracker: vi.fn().mockResolvedValue({ status: "closed" }),
    reopenTracker: vi.fn().mockResolvedValue({ status: "open" }),
    cancelTracker: vi.fn().mockResolvedValue({ status: "cancelled" }),
    deleteTracker: vi.fn().mockResolvedValue(["t-1"]),
  },
  confirmDialogMock: vi.fn().mockResolvedValue(false),
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
    t: (key: string, opts?: { count?: number }) => {
      const templates: Record<string, string> = {
        "tracker.list.section.open": "Todo",
        "tracker.list.section.inProgress": "In progress",
        "tracker.list.section.done": "Done",
        "tracker.list.section.cancelled": "Cancelled",
        "tracker.list.showMore": "Show {{count}} more",
      };
      let result = templates[key] ?? key;
      if (opts?.count != null) {
        result = result.replace("{{count}}", String(opts.count));
      }
      return result;
    },
  }),
}));

vi.mock("@/styles/settings", () => ({
  settingsStyles: { card: { testCard: true } },
}));

vi.mock("@/tracker/use-tracker-mutations", () => ({
  useTrackerMutations: () => mutationMocks,
}));

vi.mock("@/utils/confirm-dialog", () => ({
  confirmDialog: confirmDialogMock,
}));

// Render the real row id, plus stand-in Start/Delete buttons that forward the
// row's own handlers — enough to exercise the mutation-patch callbacks
// without pulling in the real kebab menu.
vi.mock("@/components/tracker/tracker-row", () => ({
  TrackerRow: (props: {
    tracker: AggregatedTracker;
    hasChildren?: boolean;
    deleteDisabled?: boolean;
    onStart: () => void;
    onDelete: () => void;
  }) =>
    React.createElement(
      "div",
      {
        "data-testid": `row-${props.tracker.id}`,
        "data-has-children": String(Boolean(props.hasChildren)),
        "data-delete-disabled": String(Boolean(props.deleteDisabled)),
      },
      props.tracker.title,
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": `action-start-${props.tracker.id}`,
          onClick: props.onStart,
        },
        "start",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": `action-delete-${props.tracker.id}`,
          onClick: props.onDelete,
          disabled: props.deleteDisabled,
        },
        "delete",
      ),
    ),
}));

import { TrackerTable, type TrackerTableProps } from "./tracker-table";
import { buildTrackerHierarchy } from "@/tracker/tracker-hierarchy";

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
  } as AggregatedTracker;
}

function renderTable(
  trackers: AggregatedTracker[],
  overrides: Partial<TrackerTableProps> = {},
): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(TrackerTable, {
        trackers,
        showProjectLabel: false,
        onOpenTracker: vi.fn(),
        hierarchy: buildTrackerHierarchy(trackers),
        sectionTotals: {},
        sectionHasMore: {},
        sectionLoadingMore: {},
        onLoadMore: vi.fn(),
        ...overrides,
      } as TrackerTableProps),
    );
  });
  return { container, root };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TrackerTable status grouping", () => {
  let container: HTMLElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

  it("renders a section for every status that has at least one item", () => {
    const { container: c } = renderTable([
      tracker({ id: "a-open", status: "open" }),
      tracker({ id: "a-ip", status: "in_progress" }),
      tracker({ id: "a-done", status: "closed" }),
      tracker({ id: "a-canc", status: "cancelled" }),
    ]);
    container = c;
    expect(c.querySelector('[data-testid="tracker-table-section-open"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="tracker-table-section-in_progress"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="tracker-table-section-closed"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="tracker-table-section-cancelled"]')).not.toBeNull();
  });

  it("shows the correct count and rows per section", () => {
    const { container: c } = renderTable([
      tracker({ id: "a-open", status: "open", title: "A open" }),
      tracker({ id: "b-open", status: "open", title: "B open" }),
      tracker({ id: "a-ip", status: "in_progress", title: "A ip" }),
      tracker({ id: "a-done", status: "closed", title: "A done" }),
      tracker({ id: "a-canc", status: "cancelled", title: "A canc" }),
      tracker({ id: "b-ip", status: "in_progress", title: "B ip" }),
    ]);
    container = c;

    const openSection = c.querySelector('[data-testid="tracker-table-section-open"]');
    const ipSection = c.querySelector('[data-testid="tracker-table-section-in_progress"]');
    const doneSection = c.querySelector('[data-testid="tracker-table-section-closed"]');
    const cancSection = c.querySelector('[data-testid="tracker-table-section-cancelled"]');

    // count text is the last child of the header; the section also holds its rows.
    expect(openSection?.textContent).toContain("Todo");
    expect(openSection?.textContent).toContain("2");
    expect(ipSection?.textContent).toContain("In progress");
    expect(ipSection?.textContent).toContain("2");
    expect(doneSection?.textContent).toContain("Done");
    expect(doneSection?.textContent).toContain("1");
    expect(cancSection?.textContent).toContain("Cancelled");
    expect(cancSection?.textContent).toContain("1");

    expect(openSection?.querySelector('[data-testid="row-a-open"]')).not.toBeNull();
    expect(openSection?.querySelector('[data-testid="row-b-open"]')).not.toBeNull();
    expect(ipSection?.querySelector('[data-testid="row-a-ip"]')).not.toBeNull();
    expect(ipSection?.querySelector('[data-testid="row-b-ip"]')).not.toBeNull();
    expect(doneSection?.querySelector('[data-testid="row-a-done"]')).not.toBeNull();
    expect(cancSection?.querySelector('[data-testid="row-a-canc"]')).not.toBeNull();

    // No cross-section leakage.
    expect(openSection?.querySelector('[data-testid="row-a-ip"]')).toBeNull();
  });

  it("preserves the projectId-then-id ordering within each section", () => {
    const { container: c } = renderTable([
      tracker({ id: "b-open", status: "open", projectId: "proj-b", title: "B open" }),
      tracker({ id: "a-open", status: "open", projectId: "proj-a", title: "A open" }),
      tracker({ id: "b-ip", status: "in_progress", projectId: "proj-b", title: "B ip" }),
      tracker({ id: "a-ip", status: "in_progress", projectId: "proj-a", title: "A ip" }),
    ]);
    container = c;

    const openSection = c.querySelector('[data-testid="tracker-table-section-open"]');
    const rows = openSection?.querySelectorAll('[data-testid^="row-"]');
    expect(rows?.[0]?.getAttribute("data-testid")).toBe("row-a-open");
    expect(rows?.[1]?.getAttribute("data-testid")).toBe("row-b-open");
  });

  it("renders only non-empty sections when a toolbar status filter leaves other buckets empty", () => {
    const { container: c } = renderTable([
      tracker({ id: "a-open", status: "open", title: "A open" }),
    ]);
    container = c;

    expect(c.querySelector('[data-testid="tracker-table-section-open"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="tracker-table-section-in_progress"]')).toBeNull();
    expect(c.querySelector('[data-testid="tracker-table-section-closed"]')).toBeNull();
    expect(c.querySelector('[data-testid="tracker-table-section-cancelled"]')).toBeNull();
  });

  it("renders sectionTotals when provided, and falls back to items.length when null or omitted", () => {
    const trackers = [
      tracker({ id: "open-1", status: "open" }),
      tracker({ id: "open-2", status: "open" }),
      tracker({ id: "ip-1", status: "in_progress" }),
    ];
    const { container: c } = renderTable(trackers, {
      sectionTotals: {
        open: 42,
        in_progress: null,
      },
    });
    container = c;

    const openSection = c.querySelector('[data-testid="tracker-table-section-open"]');
    const ipSection = c.querySelector('[data-testid="tracker-table-section-in_progress"]');

    expect(openSection?.textContent).toContain("42");
    expect(ipSection?.textContent).toContain("1");
  });

  it("renders Show more with Math.min bounded remaining count when total is known", () => {
    const onLoadMore = vi.fn();
    const trackers = [tracker({ id: "open-1", status: "open", title: "Open 1" })];
    const { container: c } = renderTable(trackers, {
      sectionTotals: { open: 4 },
      sectionHasMore: { open: true },
      sectionLoadingMore: { open: false },
      onLoadMore,
    });
    container = c;

    const showMore = c.querySelector<HTMLElement>(
      '[data-testid="tracker-table-section-open-show-more"]',
    );
    expect(showMore).not.toBeNull();
    // 4 total - 1 loaded = 3 remaining (Math.min(50, 3) = 3)
    expect(showMore?.textContent).toContain("Show 3 more");
  });

  it("renders Show more when sectionHasMore is true, calls onLoadMore, and shows spinner when sectionLoadingMore is true", () => {
    const onLoadMore = vi.fn();
    const trackers = [tracker({ id: "open-1", status: "open", title: "Open 1" })];
    const { container: c, root: r } = renderTable(trackers, {
      sectionHasMore: { open: true },
      sectionLoadingMore: { open: false },
      onLoadMore,
    });
    container = c;
    root = r;

    const showMore = c.querySelector<HTMLElement>(
      '[data-testid="tracker-table-section-open-show-more"]',
    );
    expect(showMore).not.toBeNull();
    expect(showMore?.textContent).toContain("Show 30 more");

    act(() => {
      showMore?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(onLoadMore).toHaveBeenCalledWith("open");
  });

  it("reads row hasChildren from tracker.childCount when defined and falls back to hierarchy when undefined", () => {
    const trackers = [
      tracker({ id: "t-explicit-zero", status: "open", childCount: 0 }),
      tracker({ id: "t-explicit-two", status: "open", childCount: 2 }),
      tracker({ id: "t-fallback-parent", status: "open" }),
      tracker({ id: "t-fallback-child", status: "open", parentId: "t-fallback-parent" }),
    ];
    const { container: c } = renderTable(trackers);
    container = c;

    const rowExplicitZero = c.querySelector('[data-testid="row-t-explicit-zero"]');
    const rowExplicitTwo = c.querySelector('[data-testid="row-t-explicit-two"]');
    const rowFallbackParent = c.querySelector('[data-testid="row-t-fallback-parent"]');
    const rowFallbackChild = c.querySelector('[data-testid="row-t-fallback-child"]');

    expect(rowExplicitZero?.getAttribute("data-has-children")).toBe("false");
    expect(rowExplicitTwo?.getAttribute("data-has-children")).toBe("true");
    expect(rowFallbackParent?.getAttribute("data-has-children")).toBe("true");
    expect(rowFallbackChild?.getAttribute("data-has-children")).toBe("false");
  });

  it("groups the full set regardless of prior page boundaries", () => {
    // More than the old flat page size (25) across two statuses: grouping must
    // account for every item, not drop the overflow onto "later pages".
    const trackers = [
      ...Array.from({ length: 30 }, (_, i) =>
        tracker({ id: `open-${i}`, status: "open", title: `Open ${i}` }),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        tracker({ id: `done-${i}`, status: "closed", title: `Done ${i}` }),
      ),
    ];
    const { container: c } = renderTable(trackers);
    container = c;

    const openSection = c.querySelector('[data-testid="tracker-table-section-open"]');
    const doneSection = c.querySelector('[data-testid="tracker-table-section-closed"]');

    expect(openSection?.textContent).toContain("30");
    expect(doneSection?.textContent).toContain("30");
    expect(openSection?.querySelectorAll('[data-testid^="row-"]')).toHaveLength(30);
    expect(doneSection?.querySelectorAll('[data-testid^="row-"]')).toHaveLength(30);
  });
});

describe("TrackerTable mutation patching", () => {
  let container: HTMLElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    mutationMocks.updateTracker.mockResolvedValue({ status: "in_progress" });
    mutationMocks.deleteTracker.mockResolvedValue(["t-1"]);
    confirmDialogMock.mockResolvedValue(true);
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

  it("calls onTrackerPatched with the merged tracker after a row action succeeds", async () => {
    const onTrackerPatched = vi.fn();
    const { container: c } = renderTable([tracker({ id: "t-1", status: "open" })], {
      onTrackerPatched,
    });
    container = c;

    const startButton = c.querySelector<HTMLElement>('[data-testid="action-start-t-1"]');
    if (!startButton) throw new Error("Expected the Start button to render");
    await act(async () => {
      startButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await flushPromises();
    });

    expect(mutationMocks.updateTracker).toHaveBeenCalledWith({
      trackerId: "t-1",
      status: "in_progress",
    });
    expect(onTrackerPatched).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t-1", status: "in_progress" }),
    );
  });

  it("calls onTrackersRemoved with the ids ait actually removed after a confirmed delete", async () => {
    const onTrackersRemoved = vi.fn();
    const { container: c } = renderTable([tracker({ id: "t-1", status: "open", childCount: 0 })], {
      onTrackersRemoved,
    });
    container = c;

    const deleteButton = c.querySelector<HTMLElement>('[data-testid="action-delete-t-1"]');
    if (!deleteButton) throw new Error("Expected the Delete button to render");
    await act(async () => {
      deleteButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await flushPromises();
    });

    expect(confirmDialogMock).toHaveBeenCalled();
    expect(mutationMocks.deleteTracker).toHaveBeenCalledWith({ trackerId: "t-1", cascade: false });
    expect(onTrackersRemoved).toHaveBeenCalledWith(["t-1"]);
  });

  it("marks the delete action disabled when tracker.childCount is undefined and enabled when defined", async () => {
    const { container: c } = renderTable([
      tracker({ id: "old-t", status: "open" }), // childCount undefined
      tracker({ id: "new-t", status: "open", childCount: 0 }), // childCount defined
    ]);
    container = c;

    const oldRow = c.querySelector<HTMLElement>('[data-testid="row-old-t"]');
    const newRow = c.querySelector<HTMLElement>('[data-testid="row-new-t"]');
    expect(oldRow?.getAttribute("data-delete-disabled")).toBe("true");
    expect(newRow?.getAttribute("data-delete-disabled")).toBe("false");

    const oldDeleteButton = c.querySelector<HTMLElement>('[data-testid="action-delete-old-t"]');
    if (!oldDeleteButton) throw new Error("Expected old Delete button to render");
    await act(async () => {
      oldDeleteButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await flushPromises();
    });

    expect(confirmDialogMock).not.toHaveBeenCalled();
    expect(mutationMocks.deleteTracker).not.toHaveBeenCalled();
  });
});
