/** @vitest-environment jsdom */
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AggregatedTracker } from "@/tracker/aggregated-trackers";

const { client, updateTracker } = vi.hoisted(() => ({
  client: { trackerShow: vi.fn() },
  updateTracker: vi.fn(),
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    testID,
    disabled,
    loading,
  }: {
    children: ReactNode;
    onPress: () => void;
    testID?: string;
    disabled?: boolean;
    loading?: boolean;
  }) => (
    <button type="button" onClick={onPress} data-testid={testID} disabled={disabled || loading}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/form-field", () => ({
  Field: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FormTextInput: ({ initialValue, testID }: { initialValue: string; testID?: string }) => (
    <input defaultValue={initialValue} data-testid={testID} />
  ),
}));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => client }));
vi.mock("@/tracker/use-tracker-mutations", () => ({
  useTrackerMutations: () => ({ updateTracker, isUpdating: false }),
}));

import { TrackerEditSheet } from "./tracker-edit-sheet";

const tracker: AggregatedTracker = {
  id: "pas-1",
  title: "Tracker item",
  type: "task",
  status: "open",
  priority: "P2",
  parentId: null,
  serverId: "host",
  serverName: "Host",
  projectId: "project",
  projectName: "Project",
};

describe("TrackerEditSheet", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("React", React);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("retries loading the description after a transient failure", async () => {
    client.trackerShow
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ description: "Loaded description" });
    render(<TrackerEditSheet tracker={tracker} visible onClose={vi.fn()} onUpdated={vi.fn()} />);

    await screen.findByTestId("tracker-edit-load-error");
    expect((screen.getByTestId("tracker-edit-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("tracker-edit-load-retry"));

    await waitFor(() => expect(client.trackerShow).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect((screen.getByTestId("tracker-edit-submit") as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.queryByTestId("tracker-edit-load-error")).toBeNull();
  });

  it("does not rewrite an unchanged description when editing another field", async () => {
    client.trackerShow.mockResolvedValue({ description: "  existing details  " });
    render(<TrackerEditSheet tracker={tracker} visible onClose={vi.fn()} onUpdated={vi.fn()} />);

    const save = await screen.findByTestId("tracker-edit-submit");
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);

    await waitFor(() => expect(updateTracker).toHaveBeenCalledTimes(1));
    expect(updateTracker.mock.calls[0]?.[0]).toMatchObject({
      trackerId: tracker.id,
      title: tracker.title,
    });
    expect(updateTracker.mock.calls[0]?.[0].description).toBeUndefined();
  });
});
