/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AggregatedTracker } from "@/tracker/aggregated-trackers";

const { theme } = vi.hoisted(() => ({
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
        "tracker.list.section.open": "Open",
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
  useTrackerMutations: () => ({
    updateTracker: vi.fn(),
    closeTracker: vi.fn(),
    reopenTracker: vi.fn(),
    cancelTracker: vi.fn(),
  }),
}));

// Render the real row id so we can assert which trackers land in which section.
vi.mock("@/components/tracker/tracker-row", () => ({
  TrackerRow: ({ tracker: rowTracker }: { tracker: AggregatedTracker }) =>
    React.createElement("div", { "data-testid": `row-${rowTracker.id}` }, rowTracker.title),
}));

import { TrackerTable } from "./tracker-table";

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

function renderTable(trackers: AggregatedTracker[]): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(TrackerTable, {
        trackers,
        parentTrackers: [],
        showProjectLabel: false,
        onOpenTracker: vi.fn(),
      }),
    );
  });
  return { container, root };
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

  it("renders one section per real status", () => {
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
    expect(openSection?.textContent).toContain("Open");
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
    const ipSection = c.querySelector('[data-testid="tracker-table-section-in_progress"]');

    const openRowIds = Array.from(openSection?.querySelectorAll('[data-testid^="row-"]') ?? []).map(
      (el) => el.getAttribute("data-testid"),
    );
    const ipRowIds = Array.from(ipSection?.querySelectorAll('[data-testid^="row-"]') ?? []).map(
      (el) => el.getAttribute("data-testid"),
    );

    expect(openRowIds).toEqual(["row-a-open", "row-b-open"]);
    expect(ipRowIds).toEqual(["row-a-ip", "row-b-ip"]);
  });

  it("renders every section even when empty", () => {
    const { container: c } = renderTable([tracker({ id: "only-open", status: "open" })]);
    container = c;

    const ipSection = c.querySelector('[data-testid="tracker-table-section-in_progress"]');
    const doneSection = c.querySelector('[data-testid="tracker-table-section-closed"]');
    const cancSection = c.querySelector('[data-testid="tracker-table-section-cancelled"]');

    expect(ipSection?.textContent).toContain("0");
    expect(doneSection?.textContent).toContain("0");
    expect(cancSection?.textContent).toContain("0");
    expect(ipSection?.querySelector('[data-testid^="row-"]')).toBeNull();
  });

  it("reveals at most REVEAL_STEP rows per section with a Show more control", () => {
    const many = Array.from({ length: 51 }, (_, i) =>
      tracker({ id: `open-${i}`, status: "open", title: `Open ${i}` }),
    );
    const { container: c } = renderTable(many);
    container = c;

    const openSection = c.querySelector('[data-testid="tracker-table-section-open"]');
    // Header count is the true total for the status, not the revealed slice.
    expect(openSection?.textContent).toContain("51");
    // Initially only REVEAL_STEP (50) rows render.
    expect(openSection?.querySelectorAll('[data-testid^="row-"]')).toHaveLength(50);

    const showMore = c.querySelector('[data-testid="tracker-table-section-open-show-more"]');
    expect(showMore).not.toBeNull();
    expect(showMore?.textContent).toContain("Show 1 more");

    act(() => {
      showMore?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    const openSectionAfter = c.querySelector('[data-testid="tracker-table-section-open"]');
    expect(openSectionAfter?.querySelectorAll('[data-testid^="row-"]')).toHaveLength(51);
    expect(c.querySelector('[data-testid="tracker-table-section-open-show-more"]')).toBeNull();
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
