import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  IssueNote,
  IssuePriority,
  IssueSummary,
  IssueType,
} from "@getpaseo/protocol/issues/types";
import { issuesQueryBaseKey } from "@/issues/aggregated-issues";
import { useSessionStore } from "@/stores/session-store";

export interface CreateIssueMutationInput {
  title: string;
  issueType?: IssueType;
  priority?: IssuePriority;
  parentId?: string;
  description?: string;
}

export interface UpdateIssueMutationInput {
  issueId: string;
  title?: string;
  status?: "open" | "in_progress";
  priority?: IssuePriority;
}

export interface UseIssueMutationsResult {
  createIssue: (input: CreateIssueMutationInput) => Promise<IssueSummary>;
  updateIssue: (input: UpdateIssueMutationInput) => Promise<IssueSummary>;
  closeIssue: (input: { issueId: string; note?: string }) => Promise<IssueSummary>;
  reopenIssue: (issueId: string) => Promise<IssueSummary>;
  cancelIssue: (input: { issueId: string; reason?: string }) => Promise<IssueSummary>;
  addNote: (input: { issueId: string; body: string }) => Promise<IssueNote>;
  initTracker: (prefix?: string) => Promise<{ initialised: boolean }>;
  isCreating: boolean;
  isUpdating: boolean;
  isClosing: boolean;
  isReopening: boolean;
  isCancelling: boolean;
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
export function useIssueMutations({
  serverId,
  projectId,
}: {
  serverId: string;
  projectId: string;
}): UseIssueMutationsResult {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: issuesQueryBaseKey });
  }, [queryClient]);

  const unavailableMessage = t("common.errors.daemonClientUnavailable");

  const createMutation = useMutation({
    mutationFn: (input: CreateIssueMutationInput): Promise<IssueSummary> =>
      requireClient(serverId, unavailableMessage).issuesCreate({ projectId, ...input }),
    onSettled: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: (input: UpdateIssueMutationInput): Promise<IssueSummary> =>
      requireClient(serverId, unavailableMessage).issuesUpdate({ projectId, ...input }),
    onSettled: invalidate,
  });

  const closeMutation = useMutation({
    mutationFn: (input: { issueId: string; note?: string }): Promise<IssueSummary> =>
      requireClient(serverId, unavailableMessage).issuesClose({ projectId, ...input }),
    onSettled: invalidate,
  });

  const reopenMutation = useMutation({
    mutationFn: (issueId: string): Promise<IssueSummary> =>
      requireClient(serverId, unavailableMessage).issuesReopen({ projectId, issueId }),
    onSettled: invalidate,
  });

  const cancelMutation = useMutation({
    mutationFn: (input: { issueId: string; reason?: string }): Promise<IssueSummary> =>
      requireClient(serverId, unavailableMessage).issuesCancel({ projectId, ...input }),
    onSettled: invalidate,
  });

  const addNoteMutation = useMutation({
    mutationFn: (input: { issueId: string; body: string }): Promise<IssueNote> =>
      requireClient(serverId, unavailableMessage).issuesAddNote({ projectId, ...input }),
  });

  const initMutation = useMutation({
    mutationFn: (prefix: string | undefined): Promise<{ initialised: boolean }> =>
      requireClient(serverId, unavailableMessage).issuesInit({ projectId, prefix }),
    onSettled: invalidate,
  });

  return {
    createIssue: (input) => createMutation.mutateAsync(input),
    updateIssue: (input) => updateMutation.mutateAsync(input),
    closeIssue: (input) => closeMutation.mutateAsync(input),
    reopenIssue: (issueId) => reopenMutation.mutateAsync(issueId),
    cancelIssue: (input) => cancelMutation.mutateAsync(input),
    addNote: (input) => addNoteMutation.mutateAsync(input),
    initTracker: (prefix) => initMutation.mutateAsync(prefix),
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isClosing: closeMutation.isPending,
    isReopening: reopenMutation.isPending,
    isCancelling: cancelMutation.isPending,
    isAddingNote: addNoteMutation.isPending,
    isInitialising: initMutation.isPending,
  };
}
