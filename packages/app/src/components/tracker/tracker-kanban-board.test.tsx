/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";
import { TrackerKanbanBoard } from "./tracker-kanban-board";

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

// The real SegmentedControl reads theme.borderWidth, which the shared jsdom test
// theme (test-stubs/react-native-unistyles.ts) does not define. Stand in with plain
// buttons so the board's lane-switching behavior is still exercised end to end.
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

describe("TrackerKanbanBoard — desktop layout", () => {
  it("renders every visible lane with its card count and shows the empty state for lanes with no cards", () => {
    const trackers = [
      tracker({ id: "a", status: "open", title: "Open one" }),
      tracker({ id: "b", status: "in_progress", title: "Doing one" }),
    ];

    render(<TrackerKanbanBoard trackers={trackers} filter="all" onTransition={vi.fn()} />);

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

    render(
      <TrackerKanbanBoard
        trackers={trackers}
        filter="all"
        readyIds={new Set(["unblocked"])}
        onTransition={vi.fn()}
      />,
    );

    const readyColumn = screen.getByTestId("tracker-kanban-column-ready");
    const openColumn = screen.getByTestId("tracker-kanban-column-open");
    expect(readyColumn.textContent).toContain("Unblocked one");
    expect(readyColumn.textContent).not.toContain("Blocked one");
    expect(openColumn.textContent).toContain("Blocked one");
    expect(openColumn.textContent).not.toContain("Unblocked one");
  });

  it("degrades to everything-open-stays-Open when readyIds is omitted", () => {
    const trackers = [tracker({ id: "a", status: "open", title: "Open one" })];

    render(<TrackerKanbanBoard trackers={trackers} filter="all" onTransition={vi.fn()} />);

    expect(screen.getByText("No backlog items")).toBeTruthy();
    expect(screen.getByTestId("tracker-kanban-column-open").textContent).toContain("Open one");
  });

  it("passes the project label resolver through to each card's chip, only when it returns one", () => {
    const trackers = [
      tracker({ id: "proj-a.1", title: "In project A" }),
      tracker({ id: "proj-b.1", title: "No project label" }),
    ];

    render(
      <TrackerKanbanBoard
        trackers={trackers}
        filter="all"
        onTransition={vi.fn()}
        getProjectLabel={getProjectLabelForProjectA}
      />,
    );

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

    render(<TrackerKanbanBoard trackers={trackers} filter="all" onTransition={onTransition} />);

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

    render(<TrackerKanbanBoard trackers={trackers} filter="all" onTransition={vi.fn()} />);

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

  it("renders the Done filter as a 2-lane segmented control (Done + Cancelled) and shows only the selected lane", () => {
    const trackers = [
      tracker({ id: "a", status: "closed", title: "Done one" }),
      tracker({ id: "b", status: "cancelled", title: "Cancelled one" }),
    ];

    render(<TrackerKanbanBoard trackers={trackers} filter="done" onTransition={vi.fn()} />);

    expect(screen.getByTestId("tracker-kanban-board-lane-selector-done")).toBeTruthy();
    expect(screen.getByTestId("tracker-kanban-board-lane-selector-cancelled")).toBeTruthy();
    // Effective lane defaults to the first projected lane (done); cancelled is hidden until selected.
    expect(screen.getByTestId("tracker-kanban-column-done")).toBeTruthy();
    expect(screen.queryByTestId("tracker-kanban-column-cancelled")).toBeNull();

    fireEvent.click(screen.getByTestId("tracker-kanban-board-lane-selector-cancelled"));

    expect(screen.queryByTestId("tracker-kanban-column-done")).toBeNull();
    expect(screen.getByTestId("tracker-kanban-column-cancelled")).toBeTruthy();
    expect(screen.getByText("Cancelled one")).toBeTruthy();
  });

  it("the Open filter still offers both Ready and Open lanes behind the segmented control", () => {
    const trackers = [
      tracker({ id: "unblocked", status: "open", title: "Unblocked one" }),
      tracker({ id: "blocked", status: "open", title: "Blocked one" }),
    ];

    render(
      <TrackerKanbanBoard
        trackers={trackers}
        filter="open"
        readyIds={new Set(["unblocked"])}
        onTransition={vi.fn()}
      />,
    );

    expect(screen.getByTestId("tracker-kanban-board-lane-selector-ready")).toBeTruthy();
    expect(screen.getByTestId("tracker-kanban-board-lane-selector-open")).toBeTruthy();
    expect(screen.queryByTestId("tracker-kanban-board-lane-selector-in_progress")).toBeNull();
    expect(screen.queryByTestId("tracker-kanban-board-lane-selector-done")).toBeNull();

    expect(screen.getByTestId("tracker-kanban-column-ready").textContent).toContain(
      "Unblocked one",
    );

    fireEvent.click(screen.getByTestId("tracker-kanban-board-lane-selector-open"));
    expect(screen.getByTestId("tracker-kanban-column-open").textContent).toContain("Blocked one");
  });
});
