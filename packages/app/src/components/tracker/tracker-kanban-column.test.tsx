/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";

vi.mock("@/components/tracker/tracker-kanban-card", () => ({
  TrackerKanbanCard: ({ id, title }: { id: string; title: string }) =>
    React.createElement("div", { "data-testid": `card-${id}` }, title),
}));

vi.mock("@/components/tracker/tracker-kanban-move-menu", () => ({
  TrackerKanbanCardMenu: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "move-menu" }, children),
}));

vi.mock("@/components/tracker/tracker-skeletons", () => ({
  TrackerKanbanLaneSkeleton: () => null,
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => React.createElement("span", { "data-testid": "spinner" }),
}));

vi.mock("@/components/ui/skeleton", () => ({
  SkeletonPulse: () => null,
  useSkeletonPulse: () => false,
}));

vi.mock("@/components/ui/status-badge", () => ({
  StatusBadge: ({ label }: { label: string }) =>
    React.createElement("span", { "data-testid": "badge" }, label),
}));

vi.mock("@/components/tracker/tracker-table", () => ({
  useTrackerPageStep: () => 50,
}));

import { TrackerKanbanColumn, type TrackerKanbanColumnProps } from "./tracker-kanban-column";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => cleanup());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const templates: Record<string, string> = {
        "tracker.kanban.lane.open": "Todo",
        "tracker.kanban.empty.open": "No todo items",
        "tracker.kanban.showMore": "Show {{count}} more",
      };
      const template = templates[key] ?? key;
      if (!options) return template;
      return template.replace(/\{\{(\w+)\}\}/g, (_m, token: string) =>
        String(options[token] ?? ""),
      );
    },
  }),
}));

function tracker(id: string): TrackerSummary {
  return {
    id,
    title: `Tracker ${id}`,
    type: "task",
    status: "open",
    priority: "P2",
    parentId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

function card(id: string) {
  return { tracker: tracker(id), isCancelled: false, isBlocked: false };
}

function baseProps(overrides: Partial<TrackerKanbanColumnProps> = {}): TrackerKanbanColumnProps {
  return {
    lane: "open",
    cards: [card("a"), card("b"), card("c")],
    hierarchy: {
      descendantStats: () => ({ childCount: 0, doneCount: 0 }),
    } as unknown as TrackerKanbanColumnProps["hierarchy"],
    isPending: () => false,
    onTransition: vi.fn(),
    ...overrides,
  };
}

describe("TrackerKanbanColumn Show more affordance", () => {
  it("pins the Show more button outside the scrollable card area", () => {
    render(
      <TrackerKanbanColumn
        {...baseProps({
          laneHasMore: true,
          onLoadMore: vi.fn(),
          laneTotal: 60,
        })}
      />,
    );

    const scroll = screen.getByTestId("tracker-kanban-column-open-scroll");
    const showMore = screen.getByTestId("tracker-kanban-column-open-show-more");

    // The button must NOT live inside the ScrollView's DOM subtree — otherwise
    // cards appending above it would push it down. It is a pinned sibling.
    expect(scroll.contains(showMore)).toBe(false);
  });

  it("renders Show more and reports the remaining count", () => {
    const onLoadMore = vi.fn();
    render(
      <TrackerKanbanColumn
        {...baseProps({
          laneHasMore: true,
          onLoadMore,
          laneTotal: 60,
        })}
      />,
    );

    const showMore = screen.getByTestId("tracker-kanban-column-open-show-more");
    // 60 total - 3 loaded = 57 remaining, capped at the page step (50 in this
    // test's mocked useTrackerPageStep) → the label shows the capped count.
    expect(showMore.textContent).toContain("Show 50 more");
    expect((screen.getByText("Show 50 more") as HTMLElement).style.color).toBe("rgb(37, 99, 235)");
  });

  it("fires onLoadMore with the lane when pressed", () => {
    const onLoadMore = vi.fn();
    render(
      <TrackerKanbanColumn
        {...baseProps({
          laneHasMore: true,
          onLoadMore,
          laneTotal: 60,
        })}
      />,
    );

    fireEvent.click(screen.getByTestId("tracker-kanban-column-open-show-more"));
    expect(onLoadMore).toHaveBeenCalledWith("open");
  });

  it("collapses the footer to zero height when there is no more to load", () => {
    render(<TrackerKanbanColumn {...baseProps({ laneHasMore: false })} />);

    // No reserved blank footer element, and therefore no Show more button.
    expect(screen.queryByTestId("tracker-kanban-column-open-footer")).toBeNull();
    expect(screen.queryByTestId("tracker-kanban-column-open-show-more")).toBeNull();
  });

  it("does not render Show more for an empty lane even when pagination reports more rows", () => {
    render(
      <TrackerKanbanColumn
        {...baseProps({
          cards: [],
          laneHasMore: true,
          onLoadMore: vi.fn(),
          laneTotal: 60,
        })}
      />,
    );

    expect(screen.queryByTestId("tracker-kanban-column-open-footer")).toBeNull();
    expect(screen.queryByTestId("tracker-kanban-column-open-show-more")).toBeNull();
  });
});
