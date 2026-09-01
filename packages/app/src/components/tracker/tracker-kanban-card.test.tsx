/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackerKanbanCard, type TrackerKanbanCardProps } from "./tracker-kanban-card";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => cleanup());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const templates: Record<string, string> = {
        "tracker.card.childProgress": "{{done}}/{{count}}",
        "tracker.card.created": "Created {{time}}",
        "tracker.kanban.blocked": "Blocked",
      };
      const template = templates[key] ?? key;
      if (!options) {
        return template;
      }
      return template.replace(/\{\{(\w+)\}\}/g, (_match, token: string) =>
        String(options[token] ?? ""),
      );
    },
  }),
}));

const baseProps: TrackerKanbanCardProps = {
  id: "paseo-abc.1",
  title: "Fix the thing",
  priority: "P1",
  status: "open",
};

describe("TrackerKanbanCard", () => {
  it("renders every field when all data is present", () => {
    render(
      <TrackerKanbanCard
        {...baseProps}
        projectLabel="paseo"
        childCount={7}
        doneCount={3}
        createdAt="2024-01-01T00:00:00.000Z"
        status="closed"
      />,
    );

    expect(screen.getByText(/paseo-abc\.1/)).toBeTruthy();
    expect(screen.getByText(/P1/)).toBeTruthy();
    expect(screen.getByText(/3\/7/)).toBeTruthy();
    expect(screen.getByText("paseo")).toBeTruthy();
    expect(screen.getByText("Fix the thing")).toBeTruthy();
    expect(screen.getByText(/Created/)).toBeTruthy();
  });

  it("omits every optional line when its data is absent, with no hierarchy-board leftover copy", () => {
    render(<TrackerKanbanCard {...baseProps} />);

    expect(screen.getByText("Fix the thing")).toBeTruthy();
    expect(screen.queryByText(/3\/7/)).toBeNull();
    expect(screen.queryByText(/Created/)).toBeNull();
    expect(screen.queryByText(/No tasks/i)).toBeNull();
    expect(screen.queryByText(/Standalone/i)).toBeNull();
    expect(screen.queryByText(/General/i)).toBeNull();
    expect(screen.queryByText(/Completed/i)).toBeNull();
  });

  it("does not show child progress when childCount is zero", () => {
    render(<TrackerKanbanCard {...baseProps} childCount={0} doneCount={0} />);

    expect(screen.queryByText(/0\/0/)).toBeNull();
  });

  it("shows the project chip only when a project label is passed", () => {
    const { rerender } = render(<TrackerKanbanCard {...baseProps} />);
    expect(screen.queryByText("paseo")).toBeNull();

    rerender(<TrackerKanbanCard {...baseProps} projectLabel="paseo" />);
    expect(screen.getByText("paseo")).toBeTruthy();
  });

  it("shows a blocked badge only when readiness is known and the tracker is blocked", () => {
    const { rerender } = render(<TrackerKanbanCard {...baseProps} />);
    expect(screen.queryByText("Blocked")).toBeNull();

    rerender(<TrackerKanbanCard {...baseProps} isBlocked />);
    expect(screen.getByText("Blocked")).toBeTruthy();
  });

  it("renders TrackerStatusIcon without crashing for every status", () => {
    // The lucide icon stub used under test renders null, so this can't assert
    // on the icon's DOM output — TrackerStatusIcon's own per-status icon
    // choice is that component's concern. This only confirms the card wires
    // every TrackerStatus value through without throwing.
    const { rerender } = render(<TrackerKanbanCard {...baseProps} status="open" />);
    rerender(<TrackerKanbanCard {...baseProps} status="in_progress" />);
    rerender(<TrackerKanbanCard {...baseProps} status="closed" />);
    rerender(<TrackerKanbanCard {...baseProps} status="cancelled" />);
    expect(screen.getByText("Fix the thing")).toBeTruthy();
  });
});
