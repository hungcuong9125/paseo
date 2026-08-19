import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { IssueDetail } from "@getpaseo/protocol/issues/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { IssueStatusIcon, issueStatusLabel } from "@/components/issues/issue-status-icon";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIssueMutations } from "@/issues/use-issue-mutations";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { formatTimeAgo } from "@/utils/time";
import { toErrorMessage } from "@/utils/error-messages";

export interface IssueDetailSheetProps {
  serverId: string;
  projectId: string;
  visible: boolean;
  issueId: string | null;
  onClose: () => void;
}

type DetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; issue: IssueDetail };

export function IssueDetailSheet({
  serverId,
  projectId,
  visible,
  issueId,
  onClose,
}: IssueDetailSheetProps): ReactElement | null {
  if (!visible || !issueId) {
    return null;
  }
  return (
    <OpenIssueDetailSheet
      key={issueId}
      serverId={serverId}
      projectId={projectId}
      issueId={issueId}
      onClose={onClose}
    />
  );
}

function OpenIssueDetailSheet({
  serverId,
  projectId,
  issueId,
  onClose,
}: {
  serverId: string;
  projectId: string;
  issueId: string;
  onClose: () => void;
}): ReactElement {
  const client = useHostRuntimeClient(serverId);
  const [state, setState] = useState<DetailState>({ status: "idle" });
  const [noteBody, setNoteBody] = useState("");
  const mutations = useIssueMutations({ serverId, projectId });

  const load = useCallback(async (): Promise<void> => {
    if (!client) {
      setState({ status: "error", error: "Host disconnected" });
      return;
    }
    setState({ status: "loading" });
    try {
      const issue = await client.issuesShow({ projectId, issueId });
      setState({ status: "loaded", issue });
    } catch (error) {
      setState({ status: "error", error: toErrorMessage(error) });
    }
  }, [client, projectId, issueId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleStart = useCallback(async (): Promise<void> => {
    await mutations.updateIssue({ issueId, status: "in_progress" });
    await load();
  }, [mutations, issueId, load]);

  const handleClose = useCallback(async (): Promise<void> => {
    await mutations.closeIssue({ issueId });
    await load();
  }, [mutations, issueId, load]);

  const handleReopen = useCallback(async (): Promise<void> => {
    await mutations.reopenIssue(issueId);
    await load();
  }, [mutations, issueId, load]);

  const handleCancel = useCallback(async (): Promise<void> => {
    await mutations.cancelIssue({ issueId });
    await load();
  }, [mutations, issueId, load]);

  const handleAddNote = useCallback(async (): Promise<void> => {
    const body = noteBody.trim();
    if (!body) {
      return;
    }
    await mutations.addNote({ issueId, body });
    setNoteBody("");
    await load();
  }, [mutations, issueId, noteBody, load]);

  const headerTitle = state.status === "loaded" ? state.issue.id : "Loading…";
  const header = useMemo<SheetHeader>(() => ({ title: headerTitle }), [headerTitle]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      onDismiss={onClose}
      testID="issue-detail-sheet"
    >
      {state.status === "loading" || state.status === "idle" ? (
        <View style={styles.centered}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
        </View>
      ) : null}
      {state.status === "error" ? (
        <View style={styles.centered}>
          <Text style={styles.message}>{state.error}</Text>
          <Button variant="ghost" onPress={load} testID="issue-detail-retry">
            Try again
          </Button>
        </View>
      ) : null}
      {state.status === "loaded" ? (
        <IssueDetailContent
          issue={state.issue}
          noteBody={noteBody}
          onChangeNoteBody={setNoteBody}
          onStart={handleStart}
          onClose={handleClose}
          onReopen={handleReopen}
          onCancel={handleCancel}
          onAddNote={handleAddNote}
          isAddingNote={mutations.isAddingNote}
        />
      ) : null}
    </AdaptiveModalSheet>
  );
}

function IssueDetailContent({
  issue,
  noteBody,
  onChangeNoteBody,
  onStart,
  onClose,
  onReopen,
  onCancel,
  onAddNote,
  isAddingNote,
}: {
  issue: IssueDetail;
  noteBody: string;
  onChangeNoteBody: (value: string) => void;
  onStart: () => void;
  onClose: () => void;
  onReopen: () => void;
  onCancel: () => void;
  onAddNote: () => void;
  isAddingNote: boolean;
}): ReactElement {
  const isOpenOrInProgress = issue.status === "open" || issue.status === "in_progress";

  return (
    <View style={styles.content}>
      <View style={styles.titleRow}>
        <View style={styles.titleRowIcon}>
          <IssueStatusIcon status={issue.status} size={18} />
        </View>
        <Text
          style={[
            styles.title,
            issue.status === "in_progress" && styles.titleRunning,
            issue.status === "closed" && styles.titleClosed,
            issue.status === "cancelled" && styles.titleCancelled,
          ]}
        >
          {issue.title}
        </Text>
      </View>
      <Text style={styles.meta}>
        {issueStatusLabel(issue.status)} · {issue.type} · {issue.priority}
        {issue.claimedBy ? ` · claimed by ${issue.claimedBy}` : ""}
      </Text>

      {issue.description ? <Text style={styles.description}>{issue.description}</Text> : null}

      <View style={styles.actionsRow}>
        {issue.status === "open" ? (
          <Button variant="outline" size="sm" onPress={onStart} testID="issue-detail-start">
            Start
          </Button>
        ) : null}
        {isOpenOrInProgress ? (
          <Button variant="outline" size="sm" onPress={onClose} testID="issue-detail-close">
            Close
          </Button>
        ) : null}
        {!isOpenOrInProgress ? (
          <Button variant="outline" size="sm" onPress={onReopen} testID="issue-detail-reopen">
            Reopen
          </Button>
        ) : null}
        {isOpenOrInProgress ? (
          <Button variant="ghost" size="sm" onPress={onCancel} testID="issue-detail-cancel">
            Cancel
          </Button>
        ) : null}
      </View>

      {issue.children.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Children</Text>
          {issue.children.map((child) => (
            <Text key={child.id} style={styles.listItem} numberOfLines={1}>
              {child.id} · {child.title}
            </Text>
          ))}
        </View>
      ) : null}

      {issue.blockedBy.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Blocked by</Text>
          {issue.blockedBy.map((blocker) => (
            <Text key={blocker.id} style={styles.listItem} numberOfLines={1}>
              {blocker.id} · {blocker.title}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notes</Text>
        {issue.notes.length === 0 ? <Text style={styles.emptyNotes}>No notes yet.</Text> : null}
        {issue.notes.map((note) => (
          <View key={note.id} style={styles.note}>
            <Text style={styles.noteBody}>{note.body}</Text>
            <Text style={styles.noteMeta}>{formatTimeAgo(new Date(note.createdAt))}</Text>
          </View>
        ))}
        <FormTextInput
          value={noteBody}
          onChangeText={onChangeNoteBody}
          placeholder="Add a note"
          multiline
          testID="issue-detail-note-input"
        />
        <Button
          variant="outline"
          size="sm"
          onPress={onAddNote}
          disabled={noteBody.trim().length === 0 || isAddingNote}
          loading={isAddingNote}
          testID="issue-detail-add-note"
        >
          Add note
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[4],
    padding: theme.spacing[6],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  content: {
    gap: theme.spacing[3],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  titleRowIcon: {
    paddingTop: 3,
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  // Matches the row/task-list treatment: the icon carries the "running" blue,
  // the title text just goes full-weight foreground (not muted, not tinted).
  titleRunning: {
    color: theme.colors.foreground,
  },
  titleClosed: {
    color: theme.colors.foregroundExtraMuted,
    textDecorationLine: "line-through",
  },
  titleCancelled: {
    color: theme.colors.statusDanger,
    textDecorationLine: "line-through",
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  description: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  actionsRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  section: {
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[3],
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
  },
  listItem: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  emptyNotes: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  note: {
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  noteBody: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  noteMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
