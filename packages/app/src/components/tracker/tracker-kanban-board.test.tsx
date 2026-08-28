/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";
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
  return (
    <button type="button" data-testid={option.testID} aria-pressed={selected} onClick={handleClick}>
      {option.label}
    </button>
  );
}

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
  }) => (
    <div data-testid={testID}>
      {options.map((option) => (
        <MockSegmentOption
          key={option.value}
          option={option}
          selected={option.value === value}
          onValueChange={onValueChange}
        />
      ))}
    </div>
  ),
}));

vi.mock("@/components/tracker/tracker-kanban-column", () => {
  function getEmptyMessage(lane: string): string {
    if (lane === "ready") return "No backlog items";
    if (lane === "open") return "No todo items";
    if (lane === "in_progress") return "No items in progress";
    if (lane === "done") return "No done items";
    return "No cancelled items";
  }

  return {
    TrackerKanbanColumn: (props: TrackerKanbanColumnProps) =>
      React.createElement(
        "div",
        {
          "data-testid": `tracker-kanban-column-${props.lane}`,
        },
        React.createElement("span", null, String(props.cards?.length ?? 0)),
        props.laneTotal != null ? React.createElement("span", null, String(props.laneTotal)) : null,
        props.cards?.map((card) =>
          React.createElement(
            "div",
            { key: card.tracker.id, "data-testid": `card-${card.tracker.id}` },
            React.createElement("span", null, card.tracker.title),
            card.tracker.childCount !== undefined
              ? React.createElement(
                  "span",
                  null,
                  `${card.tracker.doneCount ?? 0}/${card.tracker.childCount}`,
                )
              : null,
            props.getProjectLabel
              ? React.createElement("span", null, props.getProjectLabel(card.tracker) ?? "")
              : null,
            React.createElement(
              "button",
              {
                type: "button",
                "data-testid": `tracker-kanban-card-${card.tracker.id}-move`,
                "data-delete-disabled": String(card.tracker.childCount === undefined),
              },
              "menu",
            ),
            React.createElement(
              "span",
              { "data-testid": `tracker-kanban-card-${card.tracker.id}-move-pending` },
              props.isPending(card.tracker.id) ? "pending" : "idle",
            ),
            React.createElement(
              "button",
              {
                type: "button",
                "data-testid": `tracker-kanban-card-${card.tracker.id}-move-close`,
                onClick: () => props.onTransition(card.tracker.id, { kind: "close" }),
              },
              "close",
            ),
          ),
        ),
        props.laneHasMore
          ? React.createElement(
              "button",
              {
                type: "button",
                "data-testid": `tracker-kanban-column-${props.lane}-show-more`,
                onClick: () => props.onLoadMore?.(props.lane),
              },
              props.laneTotal != null
                ? `Show ${Math.min(50, Math.max(0, props.laneTotal - (props.cards?.length ?? 0)))} more`
                : "Show 50 more",
            )
          : null,
        (props.cards?.length ?? 0) === 0
          ? React.createElement("span", null, getEmptyMessage(props.lane))
          : null,
      ),
    laneTranslationKey: (lane: string) => (lane === "in_progress" ? "inProgress" : lane),
  };
});

import { TrackerKanbanBoard, type TrackerKanbanBoardProps } from "./tracker-kanban-board";
import type { TrackerKanbanColumnProps } from "./tracker-kanban-column";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => cleanup());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const templates: Record<string, string> = {
        "tracker.kanban.lane.ready": "Backlog",
        "tracker.kanban.lane.open": "Todo",
        "tracker.kanban.lane.inProgress": "In progress",
        "tracker.kanban.lane.done": "Done",
        "tracker.kanban.lane.cancelled": "Cancelled",
        "tracker.kanban.empty.ready": "No backlog items",
        "tracker.kanban.empty.open": "No todo items",
        "tracker.kanban.empty.inProgress": "No items in progress",
        "tracker.kanban.empty.done": "No done items",
        "tracker.kanban.empty.cancelled": "No cancelled items",
        "tracker.kanban.showMore": "Show {{count}} more",
        "tracker.kanban.error.transitionFailed": "Couldn't move {{title}}. Try again.",
      };
      const template = templates[key] ?? key;
      if (!options) return template;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, token: string) =>
        String(options[token] ?? ""),
      );
    },
  }),
}));

const useIsCompactFormFactorMock = vi.fn(() => false);
vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => useIsCompactFormFactorMock(),
}));

interface MockCardMenuCloseButtonProps {
  trackerId: string;
  testID?: string;
  onTransition: (trackerId: string, transition: { kind: "close" }) => void;
}

function MockCardMenuCloseButton({
  trackerId,
  testID,
  onTransition,
}: MockCardMenuCloseButtonProps) {
  const handleClick = React.useCallback(
    () => onTransition(trackerId, { kind: "close" }),
    [onTransition, trackerId],
  );
  return (
    <button type="button" data-testid={testID} onClick={handleClick}>
      close
    </button>
  );
}

vi.mock("@/components/tracker/tracker-kanban-move-menu", () => ({
  TrackerKanbanCardMenu: ({
    children,
    trackerId,
    isPending,
    onTransition,
    testID,
  }: {
    children: React.ReactNode;
    trackerId: string;
    isPending: boolean;
    onTransition: (trackerId: string, transition: { kind: "close" }) => void;
    testID?: string;
  }) => (
    <div data-testid={testID}>
      <span data-testid={`${testID}-pending`}>{isPending ? "pending" : "idle"}</span>
      <MockCardMenuCloseButton
        trackerId={trackerId}
        testID={`${testID}-close`}
        onTransition={onTransition}
      />
      {children}
    </div>
  ),
}));

function getProjectLabelForProjectA(summary: TrackerSummary): string | null {
  return summary.id.startsWith("proj-a") ? "Project A" : null;
}

function tracker(overrides: Partial<TrackerSummary> & Pick<TrackerSummary, "id">): TrackerSummary {
  return {
    title: overrides.id,
    type: "task",
    status: "open",
    priority: "P2",
    parentId: null,
    ...overrides,
  } as TrackerSummary;
}

function renderBoard(
  trackers: readonly TrackerSummary[],
  overrides: Partial<TrackerKanbanBoardProps> = {},
) {
  return render(
    React.createElement(TrackerKanbanBoard, {
      trackers,
      filter: "all",
      laneTotals: {},
      laneHasMore: {},
      laneLoadingMore: {},
      onLoadMore: vi.fn(),
      onTransition: vi.fn(),
      ...overrides,
    } as TrackerKanbanBoardProps),
  );
}

describe("TrackerKanbanBoard — desktop layout", () => {
  it("renders every visible lane with its card count and shows the empty state for lanes with no cards", () => {
    const trackers = [
      tracker({ id: "a", status: "open", title: "Open one" }),
      tracker({ id: "b", status: "in_progress", title: "Doing one" }),
    ];

    renderBoard(trackers);

    expect(screen.getByTestId("tracker-kanban-column-ready")).toBeTruthy();
    expect(screen.getByTestId("tracker-kanban-column-open")).toBeTruthy();
    expect(screen.getByTestId("tracker-kanban-column-in_progress")).toBeTruthy();
    expect(screen.getByTestId("tracker-kanban-column-done")).toBeTruthy();
    expect(screen.getByTestId("tracker-kanban-column-cancelled")).toBeTruthy();

    expect(screen.getByText("Open one")).toBeTruthy();
    expect(screen.getByText("Doing one")).toBeTruthy();
    expect(screen.getByText("No backlog items")).toBeTruthy();
    expect(screen.getByText("No done items")).toBeTruthy();
    expect(screen.getByText("No cancelled items")).toBeTruthy();
  });

  it("renders an open item as Ready when its id is in readyIds, leaving it out of Open", () => {
    const trackers = [
      tracker({ id: "unblocked", status: "open", title: "Unblocked one" }),
      tracker({ id: "blocked", status: "open", title: "Blocked one" }),
    ];

    renderBoard(trackers, {
      readyIds: new Set(["unblocked"]),
    });

    const readyColumn = screen.getByTestId("tracker-kanban-column-ready");
    const openColumn = screen.getByTestId("tracker-kanban-column-open");
    expect(readyColumn.textContent).toContain("Unblocked one");
    expect(readyColumn.textContent).not.toContain("Blocked one");
    expect(openColumn.textContent).toContain("Blocked one");
    expect(openColumn.textContent).not.toContain("Unblocked one");
  });

  it("degrades to everything-open-stays-Open when readyIds is omitted", () => {
    const trackers = [tracker({ id: "a", status: "open", title: "Open one" })];

    renderBoard(trackers);

    expect(screen.getByText("No backlog items")).toBeTruthy();
    expect(screen.getByTestId("tracker-kanban-column-open").textContent).toContain("Open one");
  });

  it("passes the project label resolver through to each card's chip, only when it returns one", () => {
    const trackers = [
      tracker({ id: "proj-a.1", title: "In project A" }),
      tracker({ id: "proj-b.1", title: "No project label" }),
    ];

    renderBoard(trackers, {
      getProjectLabel: getProjectLabelForProjectA,
    });

    expect(screen.getByText("Project A")).toBeTruthy();
  });

  it("marks a card pending while its transition is in flight and clears it once the promise resolves", async () => {
    const trackers = [tracker({ id: "a", status: "open", title: "Movable" })];
    let resolveTransition: () => void = () => {};
    const onTransition = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTransition = resolve;
        }),
    );

    renderBoard(trackers, { onTransition });

    const pendingLabel = screen.getByTestId("tracker-kanban-card-a-move-pending");
    expect(pendingLabel.textContent).toBe("idle");

    await act(async () => {
      fireEvent.click(screen.getByTestId("tracker-kanban-card-a-move-close"));
    });
    expect(pendingLabel.textContent).toBe("pending");
    expect(onTransition).toHaveBeenCalledWith("a", { kind: "close" });

    await act(async () => {
      resolveTransition();
      await Promise.resolve();
    });
    expect(pendingLabel.textContent).toBe("idle");
  });

  it("renders the server-supplied childCount and doneCount on cards (F1)", () => {
    const trackers = [
      tracker({ id: "parent", status: "open", title: "Parent", childCount: 10, doneCount: 4 }),
    ];

    renderBoard(trackers);

    expect(screen.getByText("4/10")).toBeTruthy();
  });

  it("disables delete-tree when tracker.childCount is undefined and enables it when defined (F2)", () => {
    const trackers = [
      tracker({ id: "old-host", status: "open", title: "Old host" }),
      tracker({ id: "new-host", status: "open", title: "New host", childCount: 0 }),
    ];

    renderBoard(trackers);

    const oldHostCardMenu = screen.getByTestId("tracker-kanban-card-old-host-move");
    const newHostCardMenu = screen.getByTestId("tracker-kanban-card-new-host-move");

    expect(oldHostCardMenu.getAttribute("data-delete-disabled")).toBe("true");
    expect(newHostCardMenu.getAttribute("data-delete-disabled")).toBe("false");
  });

  it("renders Show more label with the true remainder bounded by Math.min when laneTotal is known (F5)", () => {
    const onLoadMore = vi.fn();
    const trackers = [tracker({ id: "a", status: "open", title: "Open one" })];

    renderBoard(trackers, {
      laneTotals: { open: 4 },
      laneHasMore: { open: true },
      onLoadMore,
    });

    const showMore = screen.getByTestId("tracker-kanban-column-open-show-more");
    expect(showMore.textContent).toContain("Show 3 more");
  });

  it("keeps an empty Todo lane but anchors shared open pagination to populated Backlog", () => {
    const onLoadMore = vi.fn();
    const trackers = [tracker({ id: "ready", status: "open", title: "Backlog item" })];

    renderBoard(trackers, {
      readyIds: new Set(["ready"]),
      laneHasMore: { ready: true, open: true },
      onLoadMore,
    });

    expect(screen.queryByTestId("tracker-kanban-column-open")).not.toBeNull();
    expect(screen.queryByTestId("tracker-kanban-column-open-show-more")).toBeNull();
    expect(screen.queryByTestId("tracker-kanban-column-ready-show-more")).not.toBeNull();

    fireEvent.click(screen.getByTestId("tracker-kanban-column-ready-show-more"));
    expect(onLoadMore).toHaveBeenCalledWith("ready");
  });
});

describe("TrackerKanbanBoard — compact single-lane projection", () => {
  beforeEach(() => useIsCompactFormFactorMock.mockReturnValue(true));
  afterEach(() => useIsCompactFormFactorMock.mockReturnValue(false));

  it("renders exactly one lane behind a 5-option segmented control (Backlog, Todo, In progress, Done, Cancelled) and switches lane on selection", () => {
    const trackers = [
      tracker({ id: "a", status: "open", title: "Open one" }),
      tracker({ id: "b", status: "closed", title: "Done one" }),
      tracker({ id: "c", status: "cancelled", title: "Cancelled one" }),
    ];

    renderBoard(trackers);

    expect(screen.getByTestId("tracker-kanban-board-lane-selector-ready")).toBeTruthy();
    expect(screen.getByTestId("tracker-kanban-board-lane-selector-open")).toBeTruthy();
    expect(screen.getByTestId("tracker-kanban-board-lane-selector-in_progress")).toBeTruthy();
    expect(screen.getByTestId("tracker-kanban-board-lane-selector-done")).toBeTruthy();
    expect(screen.getByTestId("tracker-kanban-board-lane-selector-cancelled")).toBeTruthy();

    expect(screen.getByTestId("tracker-kanban-column-ready")).toBeTruthy();
    expect(screen.queryByTestId("tracker-kanban-column-open")).toBeNull();
    expect(screen.queryByTestId("tracker-kanban-column-in_progress")).toBeNull();
    expect(screen.queryByTestId("tracker-kanban-column-done")).toBeNull();
    expect(screen.queryByTestId("tracker-kanban-column-cancelled")).toBeNull();

    fireEvent.click(screen.getByTestId("tracker-kanban-board-lane-selector-done"));

    expect(screen.queryByTestId("tracker-kanban-column-ready")).toBeNull();
    expect(screen.getByTestId("tracker-kanban-column-done")).toBeTruthy();
    expect(screen.getByText("Done one")).toBeTruthy();
  });

  // Open/In Progress/Done only filter the List view's dataset — Kanban (compact
  // or not) never hides a lane for them, so the 5-lane switcher is identical to
  // the "all" filter regardless of which of these three is passed.
  it.each(["open", "in_progress", "done"] as const)(
    "the %s filter still offers all 5 lanes behind the segmented control — it's a List-only filter",
    (filter) => {
      const trackers = [
        tracker({ id: "a", status: "closed", title: "Done one" }),
        tracker({ id: "b", status: "cancelled", title: "Cancelled one" }),
      ];

      renderBoard(trackers, { filter });

      expect(screen.getByTestId("tracker-kanban-board-lane-selector-ready")).toBeTruthy();
      expect(screen.getByTestId("tracker-kanban-board-lane-selector-open")).toBeTruthy();
      expect(screen.getByTestId("tracker-kanban-board-lane-selector-in_progress")).toBeTruthy();
      expect(screen.getByTestId("tracker-kanban-board-lane-selector-done")).toBeTruthy();
      expect(screen.getByTestId("tracker-kanban-board-lane-selector-cancelled")).toBeTruthy();

      fireEvent.click(screen.getByTestId("tracker-kanban-board-lane-selector-cancelled"));
      expect(screen.getByTestId("tracker-kanban-column-cancelled").textContent).toContain(
        "Cancelled one",
      );
    },
  );

  it("a priority filter removes non-matching cards from their lane instead of hiding the lane, even in the single-lane view", () => {
    const trackers = [
      tracker({ id: "match", status: "open", priority: "P0", title: "Matches P0" }),
      tracker({ id: "no-match", status: "open", priority: "P1", title: "Not P0" }),
    ];

    renderBoard(trackers, { filter: "p0" });

    // Still all 5 lanes — priority never removes a lane from the switcher.
    expect(screen.getByTestId("tracker-kanban-board-lane-selector-in_progress")).toBeTruthy();
    expect(screen.getByTestId("tracker-kanban-board-lane-selector-done")).toBeTruthy();
    // Effective lane defaults to the first lane (Ready); both cards' status is
    // "open" with no readyIds, so they land in Open instead.
    fireEvent.click(screen.getByTestId("tracker-kanban-board-lane-selector-open"));
    expect(screen.getByText("Matches P0")).toBeTruthy();
    expect(screen.queryByText("Not P0")).toBeNull();
  });
});
