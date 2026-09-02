/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { availableTrackerTransitions, TrackerKanbanCardMenu } from "./tracker-kanban-move-menu";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => cleanup());

// jest-dom matchers aren't installed in this workspace — assert on the DOM directly.
function isDisabled(element: Element): boolean {
  return (element as HTMLButtonElement).disabled === true;
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const templates: Record<string, string> = {
        "tracker.kanban.moveMenu.trigger": "Actions for {{title}}",
        "tracker.kanban.moveMenu.title": "Actions",
        "tracker.kanban.moveTo.open": "Move to Open",
        "tracker.kanban.moveTo.inProgress": "Move to In progress",
        "tracker.kanban.moveTo.done": "Move to Done",
        "tracker.kanban.moveTo.cancelled": "Move to Cancelled",
      };
      const template = templates[key] ?? key;
      if (!options) return template;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, token: string) =>
        String(options[token] ?? ""),
      );
    },
  }),
}));

vi.mock("@/constants/platform", () => ({ isNative: false, isWeb: true }));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => children as React.ReactElement,
  DropdownMenuContent: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  DropdownMenuTrigger: ({
    children,
    testID,
    disabled,
    accessibilityLabel,
  }: {
    children:
      | React.ReactNode
      | ((state: { hovered: boolean; pressed: boolean; open: boolean }) => React.ReactNode);
    testID?: string;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) => (
    <button type="button" data-testid={testID} disabled={disabled} aria-label={accessibilityLabel}>
      {typeof children === "function"
        ? children({ hovered: false, pressed: false, open: true })
        : children}
    </button>
  ),
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => children as React.ReactElement,
  ContextMenuContent: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  ContextMenuTrigger: ({
    children,
    disabled,
    accessibilityLabel,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) => (
    <div
      data-testid="context-menu-trigger"
      aria-label={accessibilityLabel}
      data-disabled={String(Boolean(disabled))}
    >
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/menu", () => ({
  MenuItem: ({
    children,
    onSelect,
    disabled,
    testID,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
}));

describe("availableTrackerTransitions", () => {
  it("offers exactly in_progress, done, and cancelled from open", () => {
    expect(availableTrackerTransitions("open").map((option) => option.to)).toEqual([
      "in_progress",
      "done",
      "cancelled",
    ]);
  });

  it("offers exactly open, done, and cancelled from in_progress", () => {
    expect(availableTrackerTransitions("in_progress").map((option) => option.to)).toEqual([
      "open",
      "done",
      "cancelled",
    ]);
  });

  it("offers exactly open from done (never in_progress or cancelled)", () => {
    expect(availableTrackerTransitions("done").map((option) => option.to)).toEqual(["open"]);
  });

  it("offers exactly open from cancelled (reopen only)", () => {
    expect(availableTrackerTransitions("cancelled").map((option) => option.to)).toEqual(["open"]);
  });
});

describe("TrackerKanbanCardMenu (web/kebab surface)", () => {
  it("lists the transitions available from the card's current lane", () => {
    render(
      <TrackerKanbanCardMenu
        trackerId="paseo-abc.1"
        trackerTitle="Fix the thing"
        lane="open"
        isPending={false}
        onTransition={vi.fn()}
        testID="tracker-kanban-card-paseo-abc.1-move"
      >
        <span>card</span>
      </TrackerKanbanCardMenu>,
    );

    expect(
      screen.getByTestId("tracker-kanban-card-paseo-abc.1-move-item-in_progress").textContent,
    ).toBe("Move to In progress");
    expect(screen.getByTestId("tracker-kanban-card-paseo-abc.1-move-item-done").textContent).toBe(
      "Move to Done",
    );
    expect(
      screen.getByTestId("tracker-kanban-card-paseo-abc.1-move-item-cancelled").textContent,
    ).toBe("Move to Cancelled");
    expect(screen.queryByTestId("tracker-kanban-card-paseo-abc.1-move-item-open")).toBeNull();
  });

  it("calls onTransition with the tracker id and the matrix's transition on select", () => {
    const onTransition = vi.fn();
    render(
      <TrackerKanbanCardMenu
        trackerId="paseo-abc.2"
        trackerTitle="Ship it"
        lane="done"
        isPending={false}
        onTransition={onTransition}
        testID="move"
      >
        <span>card</span>
      </TrackerKanbanCardMenu>,
    );

    fireEvent.click(screen.getByTestId("move-item-open"));
    expect(onTransition).toHaveBeenCalledWith("paseo-abc.2", { kind: "reopen" });
  });

  it("calls onTransition with the cancel transition when the cancelled option is selected", () => {
    const onTransition = vi.fn();
    render(
      <TrackerKanbanCardMenu
        trackerId="paseo-abc.5"
        trackerTitle="Drop it"
        lane="open"
        isPending={false}
        onTransition={onTransition}
        testID="move"
      >
        <span>card</span>
      </TrackerKanbanCardMenu>,
    );

    fireEvent.click(screen.getByTestId("move-item-cancelled"));
    expect(onTransition).toHaveBeenCalledWith("paseo-abc.5", { kind: "cancel" });
  });

  it("disables the trigger and every item while pending", () => {
    render(
      <TrackerKanbanCardMenu
        trackerId="paseo-abc.3"
        trackerTitle="Pending thing"
        lane="in_progress"
        isPending
        onTransition={vi.fn()}
        testID="move"
      >
        <span>card</span>
      </TrackerKanbanCardMenu>,
    );

    expect(isDisabled(screen.getByTestId("move-trigger"))).toBe(true);
    expect(isDisabled(screen.getByTestId("move-item-open"))).toBe(true);
    expect(isDisabled(screen.getByTestId("move-item-done"))).toBe(true);
  });

  it("does not wrap the card in a native long-press trigger on web", () => {
    render(
      <TrackerKanbanCardMenu
        trackerId="paseo-abc.4"
        trackerTitle="Web card"
        lane="open"
        isPending={false}
        onTransition={vi.fn()}
      >
        <span>card</span>
      </TrackerKanbanCardMenu>,
    );

    expect(screen.queryByTestId("context-menu-trigger")).toBeNull();
  });
});
