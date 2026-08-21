import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  TrackerNote,
  TrackerPriority,
  TrackerSummary,
  TrackerType,
} from "@getpaseo/protocol/tracker/types";
import { trackerQueryBaseKey } from "@/tracker/aggregated-trackers";
import { useSessionStore } from "@/stores/session-store";

export interface CreateTrackerMutationInput {
  title: string;
  trackerType?: TrackerType;
  priority?: TrackerPriority;
  parentId?: string;
  description?: string;
}

export interface UpdateTrackerMutationInput {
  trackerId: string;
  title?: string;
  status?: "open" | "in_progress";
  priority?: TrackerPriority;
  description?: string;
}

export interface UseTrackerMutationsResult {
  createTracker: (input: CreateTrackerMutationInput) => Promise<TrackerSummary>;
  updateTracker: (input: UpdateTrackerMutationInput) => Promise<TrackerSummary>;
  closeTracker: (input: { trackerId: string; note?: string }) => Promise<TrackerSummary>;
  reopenTracker: (trackerId: string) => Promise<TrackerSummary>;
  cancelTracker: (input: { trackerId: string; reason?: string }) => Promise<TrackerSummary>;
  deleteTracker: (input: { trackerId: string; cascade?: boolean }) => Promise<string[]>;
  addNote: (input: { trackerId: string; body: string }) => Promise<TrackerNote>;
  initTracker: (prefix?: string) => Promise<{ initialised: boolean }>;
  isCreating: boolean;
  isUpdating: boolean;
  isClosing: boolean;
  isReopening: boolean;
  isCancelling: boolean;
  isDeleting: boolean;
  isAddingNote: boolean;
  isInitialising: boolean;
}

function requireClient(serverId: string, unavailableMessage: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error(unavailableMessage);
  }
  return client;
}

/**
 * Mutations for one specific project. `serverId`/`projectId` identify which
 * project's `.ait/ait.db` the action targets — a row from an aggregated "all
 * projects" list carries its own `projectId`, so this hook does not need a
 * screen-level "current project" concept.
 */
export function useTrackerMutations({
  serverId,
  projectId,
}: {
  serverId: string;
  projectId: string;
}): UseTrackerMutationsResult {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: trackerQueryBaseKey });
  }, [queryClient]);

  const unavailableMessage = t("common.errors.daemonClientUnavailable");

  const createMutation = useMutation({
    mutationFn: (input: CreateTrackerMutationInput): Promise<TrackerSummary> =>
      requireClient(serverId, unavailableMessage).trackerCreate({ projectId, ...input }),
    onSettled: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: (input: UpdateTrackerMutationInput): Promise<TrackerSummary> =>
      requireClient(serverId, unavailableMessage).trackerUpdate({ projectId, ...input }),
    onSettled: invalidate,
  });

  const closeMutation = useMutation({
    mutationFn: (input: { trackerId: string; note?: string }): Promise<TrackerSummary> =>
      requireClient(serverId, unavailableMessage).trackerClose({ projectId, ...input }),
    onSettled: invalidate,
  });

  const reopenMutation = useMutation({
    mutationFn: (trackerId: string): Promise<TrackerSummary> =>
      requireClient(serverId, unavailableMessage).trackerReopen({ projectId, trackerId }),
    onSettled: invalidate,
  });

  const cancelMutation = useMutation({
    mutationFn: (input: { trackerId: string; reason?: string }): Promise<TrackerSummary> =>
      requireClient(serverId, unavailableMessage).trackerCancel({ projectId, ...input }),
    onSettled: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (input: { trackerId: string; cascade?: boolean }): Promise<string[]> =>
      requireClient(serverId, unavailableMessage).trackerDelete({ projectId, ...input }),
    onSettled: invalidate,
  });

  const addNoteMutation = useMutation({
    mutationFn: (input: { trackerId: string; body: string }): Promise<TrackerNote> =>
      requireClient(serverId, unavailableMessage).trackerAddNote({ projectId, ...input }),
  });

  const initMutation = useMutation({
    mutationFn: (prefix: string | undefined): Promise<{ initialised: boolean }> =>
      requireClient(serverId, unavailableMessage).trackerInit({ projectId, prefix }),
    onSettled: invalidate,
  });

  return {
    createTracker: (input) => createMutation.mutateAsync(input),
    updateTracker: (input) => updateMutation.mutateAsync(input),
    closeTracker: (input) => closeMutation.mutateAsync(input),
    reopenTracker: (trackerId) => reopenMutation.mutateAsync(trackerId),
    cancelTracker: (input) => cancelMutation.mutateAsync(input),
    deleteTracker: (input) => deleteMutation.mutateAsync(input),
    addNote: (input) => addNoteMutation.mutateAsync(input),
    initTracker: (prefix) => initMutation.mutateAsync(prefix),
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isClosing: closeMutation.isPending,
    isReopening: reopenMutation.isPending,
    isCancelling: cancelMutation.isPending,
    isDeleting: deleteMutation.isPending,
    isAddingNote: addNoteMutation.isPending,
    isInitialising: initMutation.isPending,
  };
}
