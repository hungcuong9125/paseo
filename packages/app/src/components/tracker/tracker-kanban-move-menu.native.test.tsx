/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackerKanbanCardMenu } from "./tracker-kanban-move-menu";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => cleanup());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const templates: Record<string, string> = {
        "tracker.kanban.moveMenu.trigger": "Move {{title}}",
        "tracker.kanban.moveMenu.title": "Move to…",
        "tracker.kanban.moveTo.open": "Move to Open",
        "tracker.kanban.moveTo.inProgress": "Move to In progress",
        "tracker.kanban.moveTo.done": "Move to Done",
      };
      const template = templates[key] ?? key;
      if (!options) return template;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, token: string) =>
        String(options[token] ?? ""),
      );
    },
  }),
}));

// Native ships long-press on the card body in addition to the always-present kebab
// (docs/refactors/tracker-kanban-redesign.md, "Platform split"). isNative is a static
// module-level constant, so it is mocked per-file rather than toggled mid-suite.
vi.mock("@/constants/platform", () => ({ isNative: true, isWeb: false }));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => children as React.ReactElement,
  DropdownMenuContent: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  DropdownMenuTrigger: ({
    children,
    testID,
  }: {
    children:
      | React.ReactNode
      | ((state: { hovered: boolean; pressed: boolean; open: boolean }) => React.ReactNode);
    testID?: string;
  }) => (
    <button type="button" data-testid={testID}>
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
  // Real ContextMenuTrigger spreads a plain `onPress` straight onto the underlying RN
  // Pressable alongside its own `onLongPress` — the same component handles both
  // gestures. This mock forwards `onPress` the same way (as a click handler on the
  // trigger's own element) so the tap-to-open wiring is exercised without a second,
  // nested pressable — see TrackerKanbanCardMenu's docstring for why that matters.
  ContextMenuTrigger: ({
    children,
    disabled,
    enabledOnWeb,
    accessibilityLabel,
    onPress,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    enabledOnWeb?: boolean;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) => (
    <div
      data-testid="context-menu-trigger"
      data-enabled-on-web={String(Boolean(enabledOnWeb))}
      data-disabled={String(Boolean(disabled))}
      aria-label={accessibilityLabel}
      onClick={disabled ? undefined : onPress}
    >
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/menu", () => ({
  MenuItem: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <button type="button" data-testid={testID}>
      {children}
    </button>
  ),
}));

describe("TrackerKanbanCardMenu (native long-press surface)", () => {
  it("wraps the card body in a long-press trigger disabled on web, listing the same transitions", () => {
    render(
      <TrackerKanbanCardMenu
        trackerId="paseo-abc.1"
        trackerTitle="Fix the thing"
        lane="open"
        isPending={false}
        onTransition={vi.fn()}
        testID="move"
      >
        <span>card body</span>
      </TrackerKanbanCardMenu>,
    );

    const trigger = screen.getByTestId("context-menu-trigger");
    expect(trigger.getAttribute("data-enabled-on-web")).toBe("false");
    expect(trigger.textContent).toContain("card body");

    expect(screen.getByTestId("move-context-item-in_progress").textContent).toBe(
      "Move to In progress",
    );
    expect(screen.getByTestId("move-context-item-done").textContent).toBe("Move to Done");
    // The kebab surface is still present on native — it is the screen-reader-guaranteed path.
    expect(screen.getByTestId("move-trigger")).toBeTruthy();
  });

  it("marks the long-press trigger disabled while pending", () => {
    render(
      <TrackerKanbanCardMenu
        trackerId="paseo-abc.2"
        trackerTitle="Pending thing"
        lane="open"
        isPending
        onTransition={vi.fn()}
        testID="move"
      >
        <span>card</span>
      </TrackerKanbanCardMenu>,
    );

    expect(screen.getByTestId("context-menu-trigger").getAttribute("data-disabled")).toBe("true");
  });

  it("fires onCardPress from the same trigger that owns long-press, not a nested pressable", () => {
    const onCardPress = vi.fn();
    render(
      <TrackerKanbanCardMenu
        trackerId="paseo-abc.3"
        trackerTitle="Tappable thing"
        lane="open"
        isPending={false}
        onTransition={vi.fn()}
        onCardPress={onCardPress}
        testID="move"
      >
        <span>card body</span>
      </TrackerKanbanCardMenu>,
    );

    fireEvent.click(screen.getByTestId("context-menu-trigger"));
    expect(onCardPress).toHaveBeenCalledWith("paseo-abc.3");
  });

  it("does not fire onCardPress while pending", () => {
    const onCardPress = vi.fn();
    render(
      <TrackerKanbanCardMenu
        trackerId="paseo-abc.4"
        trackerTitle="Pending thing"
        lane="open"
        isPending
        onTransition={vi.fn()}
        onCardPress={onCardPress}
        testID="move"
      >
        <span>card body</span>
      </TrackerKanbanCardMenu>,
    );

    fireEvent.click(screen.getByTestId("context-menu-trigger"));
    expect(onCardPress).not.toHaveBeenCalled();
  });
});
