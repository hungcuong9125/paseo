/** @vitest-environment jsdom */
import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import type { TrackerDetail, TrackerSummary } from "@getpaseo/protocol/tracker/types";

const { client, mutations } = vi.hoisted(() => ({
  client: { trackerShow: vi.fn() },
  mutations: {
    updateTracker: vi.fn(),
    closeTracker: vi.fn(),
    reopenTracker: vi.fn(),
    cancelTracker: vi.fn(),
    addNote: vi.fn(),
    isAddingNote: false,
  },
}));

// Native sheet/field shells have no meaningful layout in JSDOM. Keep the real
// detail component and query ownership; RPCs are deterministic provider doubles.
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
  }: {
    children: ReactNode;
    onPress: () => void;
    testID?: string;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} data-testid={testID} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/form-field", () => ({
  FormTextInput: React.forwardRef(function MockFormTextInput(
    {
      initialValue,
      onChangeText,
      editable,
      testID,
    }: {
      initialValue: string;
      onChangeText: (value: string) => void;
      editable?: boolean;
      testID?: string;
    },
    ref,
  ) {
    const inputRef = React.useRef<HTMLInputElement>(null);
    const handleChange = React.useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => onChangeText(event.target.value),
      [onChangeText],
    );
    React.useImperativeHandle(
      ref,
      () =>
        ({
          replaceText(nextValue: string) {
            if (inputRef.current) inputRef.current.value = nextValue;
          },
        }) as EditingTextInputHandle,
      [],
    );
    return (
      <input
        ref={inputRef}
        defaultValue={initialValue}
        onChange={handleChange}
        disabled={editable === false}
        data-testid={testID}
      />
    );
  }),
}));
vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => <div>Loading detail</div>,
}));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => client }));
vi.mock("@/tracker/use-tracker-mutations", () => ({ useTrackerMutations: () => mutations }));

import { TrackerDetailSheet } from "./tracker-detail-sheet";

function detail(id: string): TrackerDetail {
  return {
    id,
    title: `${id} title`,
    type: "task",
    priority: "P2",
    status: "open",
    parentId: null,
    description: null,
    claimedBy: null,
    createdAt: "2026-10-08T00:00:00Z",
    updatedAt: "2026-10-08T00:00:00Z",
    closedAt: null,
    children: [],
    blockedBy: [],
    notes: [],
  };
}

function renderDetail(initialSummary?: TrackerSummary | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const onMutated = vi.fn();
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <TrackerDetailSheet
        serverId="host"
        projectId="project"
        trackerId="parent"
        visible
        initialSummary={initialSummary}
        onClose={onClose}
        onMutated={onMutated}
      />
    </QueryClientProvider>,
  );
  return { onMutated };
}

describe("TrackerDetailSheet", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("React", React);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("hides parent actions while loading a child and ignores a late child response after Back", async () => {
    const child = Promise.withResolvers<TrackerDetail>();
    const parent = { ...detail("parent"), children: [detail("child")] };
    client.trackerShow.mockImplementation(async ({ trackerId }: { trackerId: string }) =>
      trackerId === "parent" ? parent : child.promise,
    );
    renderDetail();
    await screen.findByText("parent title");
    fireEvent.change(screen.getByTestId("tracker-detail-note-input"), {
      target: { value: "parent draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open child child" }));
    await screen.findByText("Loading detail");
    expect(screen.queryByTestId("tracker-detail-start")).toBeNull();
    expect(screen.queryByText("parent title")).toBeNull();
    fireEvent.click(screen.getByTestId("tracker-detail-back"));
    await screen.findByText("parent title");
    expect((screen.getByTestId("tracker-detail-note-input") as HTMLInputElement).value).toBe(
      "parent draft",
    );
    await act(async () => child.resolve(detail("child")));
    expect(screen.getByText("parent title")).not.toBeNull();
    expect(screen.queryByText("child title")).toBeNull();
  });

  it("shows a mutation failure and permits a successful retry without closing the detail", async () => {
    client.trackerShow.mockResolvedValue(detail("parent"));
    mutations.closeTracker
      .mockRejectedValueOnce(new Error("Close failed"))
      .mockResolvedValueOnce({ ...detail("parent"), status: "closed" });
    const { onMutated } = renderDetail();
    await screen.findByText("parent title");
    fireEvent.click(screen.getByTestId("tracker-detail-close"));
    await screen.findByText("Close failed");
    expect(onMutated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("tracker-detail-close"));
    await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Close failed")).toBeNull();
    expect(mutations.closeTracker).toHaveBeenCalledTimes(2);
  });

  it("renders the committed note if the follow-up detail refresh fails", async () => {
    const detailRecord = detail("parent");
    client.trackerShow
      .mockResolvedValueOnce(detailRecord)
      .mockRejectedValueOnce(new Error("offline"));
    const committed = Promise.withResolvers<{
      id: string;
      body: string;
      createdAt: string;
    }>();
    mutations.addNote.mockReturnValueOnce(committed.promise);
    renderDetail();
    await screen.findByText("parent title");

    fireEvent.change(screen.getByTestId("tracker-detail-note-input"), {
      target: { value: "committed note" },
    });
    fireEvent.click(screen.getByTestId("tracker-detail-add-note"));
    await waitFor(() =>
      expect(screen.getByTestId("tracker-detail-note-input")).toHaveProperty("disabled", true),
    );

    await act(async () =>
      committed.resolve({
        id: "note-1",
        body: "committed note",
        createdAt: "2026-10-09T00:00:00Z",
      }),
    );
    await screen.findByText("committed note");
    await screen.findByText("offline");
    expect(client.trackerShow).toHaveBeenCalledTimes(2);
  });

  it("keeps actions disabled while only the summary placeholder is available", async () => {
    client.trackerShow.mockReturnValue(new Promise(() => {}));
    renderDetail(detail("parent"));

    await screen.findByText("parent title");
    expect((screen.getByTestId("tracker-detail-close") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("tracker-detail-note-input") as HTMLInputElement).disabled).toBe(
      true,
    );
  });
});
