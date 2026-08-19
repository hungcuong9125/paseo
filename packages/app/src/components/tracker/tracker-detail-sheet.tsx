import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TrackerDetail } from "@getpaseo/protocol/tracker/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { TrackerStatusIcon, trackerStatusLabel } from "@/components/tracker/tracker-status-icon";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useTrackerMutations } from "@/tracker/use-tracker-mutations";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { formatTimeAgo } from "@/utils/time";
import { toErrorMessage } from "@/utils/error-messages";

export interface TrackerDetailSheetProps {
  serverId: string;
  projectId: string;
  visible: boolean;
  trackerId: string | null;
  onClose: () => void;
}

type DetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; tracker: TrackerDetail };

export function TrackerDetailSheet({
  serverId,
  projectId,
  visible,
  trackerId,
  onClose,
}: TrackerDetailSheetProps): ReactElement | null {
  if (!visible || !trackerId) {
    return null;
  }
  return (
    <OpenTrackerDetailSheet
      key={trackerId}
      serverId={serverId}
      projectId={projectId}
      trackerId={trackerId}
      onClose={onClose}
    />
  );
}

function OpenTrackerDetailSheet({
  serverId,
  projectId,
  trackerId,
  onClose,
}: {
  serverId: string;
  projectId: string;
  trackerId: string;
  onClose: () => void;
}): ReactElement {
  const client = useHostRuntimeClient(serverId);
  const [state, setState] = useState<DetailState>({ status: "idle" });
  const [noteBody, setNoteBody] = useState("");
  const mutations = useTrackerMutations({ serverId, projectId });

  const load = useCallback(async (): Promise<void> => {
    if (!client) {
      setState({ status: "error", error: "Host disconnected" });
      return;
    }
    setState({ status: "loading" });
    try {
      const tracker = await client.trackerShow({ projectId, trackerId });
      setState({ status: "loaded", tracker });
    } catch (error) {
      setState({ status: "error", error: toErrorMessage(error) });
    }
  }, [client, projectId, trackerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleStart = useCallback(async (): Promise<void> => {
    await mutations.updateTracker({ trackerId, status: "in_progress" });
    await load();
  }, [mutations, trackerId, load]);

  const handleClose = useCallback(async (): Promise<void> => {
    await mutations.closeTracker({ trackerId });
    await load();
  }, [mutations, trackerId, load]);

  const handleReopen = useCallback(async (): Promise<void> => {
    await mutations.reopenTracker(trackerId);
    await load();
  }, [mutations, trackerId, load]);

  const handleCancel = useCallback(async (): Promise<void> => {
    await mutations.cancelTracker({ trackerId });
    await load();
  }, [mutations, trackerId, load]);

  const handleAddNote = useCallback(async (): Promise<void> => {
    const body = noteBody.trim();
    if (!body) {
      return;
    }
    await mutations.addNote({ trackerId, body });
    setNoteBody("");
    await load();
  }, [mutations, trackerId, noteBody, load]);

  const headerTitle = state.status === "loaded" ? state.tracker.id : "Loading…";
  const header = useMemo<SheetHeader>(() => ({ title: headerTitle }), [headerTitle]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      onDismiss={onClose}
      testID="tracker-detail-sheet"
    >
      {state.status === "loading" || state.status === "idle" ? (
        <View style={styles.centered}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
        </View>
      ) : null}
      {state.status === "error" ? (
        <View style={styles.centered}>
          <Text style={styles.message}>{state.error}</Text>
          <Button variant="ghost" onPress={load} testID="tracker-detail-retry">
            Try again
          </Button>
        </View>
      ) : null}
      {state.status === "loaded" ? (
        <TrackerDetailContent
          tracker={state.tracker}
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

function TrackerDetailContent({
  tracker,
  noteBody,
  onChangeNoteBody,
  onStart,
  onClose,
  onReopen,
  onCancel,
  onAddNote,
  isAddingNote,
}: {
  tracker: TrackerDetail;
  noteBody: string;
  onChangeNoteBody: (value: string) => void;
  onStart: () => void;
  onClose: () => void;
  onReopen: () => void;
  onCancel: () => void;
  onAddNote: () => void;
  isAddingNote: boolean;
}): ReactElement {
  const isOpenOrInProgress = tracker.status === "open" || tracker.status === "in_progress";

  return (
    <View style={styles.content}>
      <View style={styles.titleRow}>
        <View style={styles.titleRowIcon}>
          <TrackerStatusIcon status={tracker.status} size={18} />
        </View>
        <Text
          style={[
            styles.title,
            tracker.status === "in_progress" && styles.titleRunning,
            tracker.status === "closed" && styles.titleClosed,
            tracker.status === "cancelled" && styles.titleCancelled,
          ]}
        >
          {tracker.title}
        </Text>
      </View>
      <Text style={styles.meta}>
        {trackerStatusLabel(tracker.status)} · {tracker.type} · {tracker.priority}
        {tracker.claimedBy ? ` · claimed by ${tracker.claimedBy}` : ""}
      </Text>

      {tracker.description ? <Text style={styles.description}>{tracker.description}</Text> : null}

      <View style={styles.actionsRow}>
        {tracker.status === "open" ? (
          <Button variant="outline" size="sm" onPress={onStart} testID="tracker-detail-start">
            Start
          </Button>
        ) : null}
        {isOpenOrInProgress ? (
          <Button variant="outline" size="sm" onPress={onClose} testID="tracker-detail-close">
            Close
          </Button>
        ) : null}
        {!isOpenOrInProgress ? (
          <Button variant="outline" size="sm" onPress={onReopen} testID="tracker-detail-reopen">
            Reopen
          </Button>
        ) : null}
        {isOpenOrInProgress ? (
          <Button variant="ghost" size="sm" onPress={onCancel} testID="tracker-detail-cancel">
            Cancel
          </Button>
        ) : null}
      </View>

      {tracker.children.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Children</Text>
          {tracker.children.map((child) => (
            <Text key={child.id} style={styles.listItem} numberOfLines={1}>
              {child.id} · {child.title}
            </Text>
          ))}
        </View>
      ) : null}

      {tracker.blockedBy.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Blocked by</Text>
          {tracker.blockedBy.map((blocker) => (
            <Text key={blocker.id} style={styles.listItem} numberOfLines={1}>
              {blocker.id} · {blocker.title}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notes</Text>
        {tracker.notes.length === 0 ? <Text style={styles.emptyNotes}>No notes yet.</Text> : null}
        {tracker.notes.map((note) => (
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
          testID="tracker-detail-note-input"
        />
        <Button
          variant="outline"
          size="sm"
          onPress={onAddNote}
          disabled={noteBody.trim().length === 0 || isAddingNote}
          loading={isAddingNote}
          testID="tracker-detail-add-note"
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
