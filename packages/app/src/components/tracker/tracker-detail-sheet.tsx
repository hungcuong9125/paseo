import { useCallback, useMemo, useRef, useState, type ReactElement, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TrackerDetail, TrackerSummary } from "@getpaseo/protocol/tracker/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { TrackerStatusIcon, trackerStatusLabel } from "@/components/tracker/tracker-status-icon";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useTrackerMutations } from "@/tracker/use-tracker-mutations";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { formatTimeAgo } from "@/utils/time";
import { toErrorMessage } from "@/utils/error-messages";
import { trackerQueryBaseKey } from "@/tracker/aggregated-trackers";

export interface TrackerDetailSheetProps {
  serverId: string;
  projectId: string;
  visible: boolean;
  trackerId: string | null;
  onClose: () => void;
  /** The summary already on hand from the row/card that opened this sheet —
   * lets the sheet render title/status/priority immediately instead of a
   * spinner, while the full record (children/blockedBy/notes/description)
   * loads in behind it. Omit when there's nothing to seed with. */
  initialSummary?: TrackerSummary | null;
  /** Fires with the mutation's own response after Start/Close/Reopen/Cancel
   * succeeds — the caller patches its shared data hook in place so the view
   * behind this sheet reflects the change without a re-fetch. */
  onMutated?: (tracker: TrackerSummary) => void;
}

type DetailState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; tracker: TrackerDetail; refreshError?: string };

type ActionState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error"; message: string };

// The fields `ait show` adds beyond a summary row are unknown until the real
// fetch resolves — description/children/blockedBy/notes stay empty in the
// placeholder and fill in once `load()`'s background fetch completes.
function placeholderDetailFromSummary(summary: TrackerSummary): TrackerDetail {
  return {
    id: summary.id,
    title: summary.title,
    type: summary.type,
    status: summary.status,
    priority: summary.priority,
    parentId: summary.parentId,
    description: null,
    claimedBy: summary.claimedBy ?? null,
    createdAt: summary.createdAt ?? "",
    updatedAt: summary.updatedAt ?? "",
    closedAt: summary.closedAt ?? null,
    children: [],
    blockedBy: [],
    notes: [],
  };
}

function trackerDetailQueryKey(serverId: string, projectId: string, trackerId: string) {
  return [...trackerQueryBaseKey, serverId, projectId, trackerId, "detail"] as const;
}

export function TrackerDetailSheet({
  serverId,
  projectId,
  visible,
  trackerId,
  onClose,
  initialSummary,
  onMutated,
}: TrackerDetailSheetProps): ReactElement | null {
  if (!visible || !trackerId) {
    return null;
  }
  return (
    <OpenTrackerDetailSheet
      key={`${serverId}:${projectId}:${trackerId}`}
      serverId={serverId}
      projectId={projectId}
      trackerId={trackerId}
      onClose={onClose}
      initialSummary={initialSummary ?? null}
      onMutated={onMutated}
    />
  );
}

function OpenTrackerDetailSheet({
  serverId,
  projectId,
  trackerId,
  onClose,
  initialSummary,
  onMutated,
}: {
  serverId: string;
  projectId: string;
  trackerId: string;
  onClose: () => void;
  initialSummary: TrackerSummary | null;
  onMutated?: (tracker: TrackerSummary) => void;
}): ReactElement {
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const [noteBody, setNoteBody] = useState("");
  const noteDraftsRef = useRef<Record<string, string>>({});
  const noteInputRef = useRef<EditingTextInputHandle | null>(null);
  // The root tracker is history[0]; opening a child pushes its id, Back pops.
  // The sheet always shows history[history.length - 1].
  const [history, setHistory] = useState<string[]>([trackerId]);
  const activeTrackerId = history[history.length - 1] ?? trackerId;
  const mutations = useTrackerMutations({ serverId, projectId });
  const [actionState, setActionState] = useState<ActionState>({ status: "idle" });
  const actionPending = useRef(false);
  const runAction = useCallback(async (operation: () => Promise<void>): Promise<void> => {
    if (actionPending.current) return;
    actionPending.current = true;
    setActionState({ status: "pending" });
    try {
      await operation();
      setActionState({ status: "idle" });
    } catch (error) {
      setActionState({ status: "error", message: toErrorMessage(error) });
    } finally {
      actionPending.current = false;
    }
  }, []);
  const detail = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    enabled: client !== null,
    queryKey: trackerDetailQueryKey(serverId, projectId, activeTrackerId),
    queryFn: async () => {
      if (!client) throw new Error("Host disconnected");
      return client.trackerShow({ projectId, trackerId: activeTrackerId });
    },
    retry: false,
  });
  let state: DetailState;
  if (!client) state = { status: "error", error: "Host disconnected" };
  else if (detail.data) {
    state = {
      status: "loaded",
      tracker: detail.data,
      ...(detail.isError ? { refreshError: toErrorMessage(detail.error) } : {}),
    };
  } else if (detail.isError) state = { status: "error", error: toErrorMessage(detail.error) };
  else if (initialSummary?.id === activeTrackerId) {
    state = { status: "loaded", tracker: placeholderDetailFromSummary(initialSummary) };
  } else state = { status: "loading" };
  const { refetch } = detail;
  const load = useCallback(async (): Promise<void> => {
    await refetch();
  }, [refetch]);

  const handleStart = useCallback(async (): Promise<void> => {
    const summary = await mutations.updateTracker({
      trackerId: activeTrackerId,
      status: "in_progress",
    });
    onMutated?.(summary);
    await load();
  }, [activeTrackerId, load, mutations, onMutated]);

  const handleClose = useCallback(async (): Promise<void> => {
    const summary = await mutations.closeTracker({ trackerId: activeTrackerId });
    onMutated?.(summary);
    await load();
  }, [activeTrackerId, load, mutations, onMutated]);

  const handleReopen = useCallback(async (): Promise<void> => {
    const summary = await mutations.reopenTracker(activeTrackerId);
    onMutated?.(summary);
    await load();
  }, [activeTrackerId, load, mutations, onMutated]);

  const handleCancel = useCallback(async (): Promise<void> => {
    const summary = await mutations.cancelTracker({ trackerId: activeTrackerId });
    onMutated?.(summary);
    await load();
  }, [activeTrackerId, load, mutations, onMutated]);

  const handleAddNote = useCallback(async (): Promise<void> => {
    const body = noteBody.trim();
    if (!body) {
      return;
    }
    const committedNote = await mutations.addNote({ trackerId: activeTrackerId, body });
    queryClient.setQueryData<TrackerDetail | undefined>(
      trackerDetailQueryKey(serverId, projectId, activeTrackerId),
      (current) => {
        if (!current) return current;
        return {
          ...current,
          notes: [...current.notes.filter((note) => note.id !== committedNote.id), committedNote],
        };
      },
    );
    noteDraftsRef.current[activeTrackerId] = "";
    setNoteBody("");
    noteInputRef.current?.replaceText("");
    await load();
  }, [activeTrackerId, load, mutations, noteBody, projectId, queryClient, serverId]);

  const setCurrentNoteDraft = useCallback(
    (value: string) => {
      noteDraftsRef.current[activeTrackerId] = value;
      setNoteBody(value);
    },
    [activeTrackerId],
  );

  const handleOpenChild = useCallback(
    (childId: string) => {
      if (actionPending.current) return;
      noteDraftsRef.current[activeTrackerId] = noteBody;
      setActionState({ status: "idle" });
      const nextDraft = noteDraftsRef.current[childId] ?? "";
      setNoteBody(nextDraft);
      noteInputRef.current?.replaceText(nextDraft);
      setHistory((current) => [...current, childId]);
    },
    [activeTrackerId, noteBody],
  );

  const handleBack = useCallback(() => {
    if (actionPending.current) return;
    noteDraftsRef.current[activeTrackerId] = noteBody;
    setActionState({ status: "idle" });
    const previousId = history[history.length - 2] ?? trackerId;
    const previousDraft = noteDraftsRef.current[previousId] ?? "";
    setNoteBody(previousDraft);
    noteInputRef.current?.replaceText(previousDraft);
    setHistory((current) => (current.length > 1 ? current.slice(0, -1) : current));
  }, [activeTrackerId, history, noteBody, trackerId]);

  const canGoBack = history.length > 1;
  const start = useCallback(() => void runAction(handleStart), [runAction, handleStart]);
  const close = useCallback(() => void runAction(handleClose), [runAction, handleClose]);
  const reopen = useCallback(() => void runAction(handleReopen), [runAction, handleReopen]);
  const cancel = useCallback(() => void runAction(handleCancel), [runAction, handleCancel]);
  const addNote = useCallback(() => void runAction(handleAddNote), [runAction, handleAddNote]);

  const headerTitle = state.status === "loaded" ? state.tracker.id : "Loading…";
  const headerStatus = state.status === "loaded" ? state.tracker.status : null;
  const header = useMemo<SheetHeader>(
    () => ({
      title: headerTitle,
      leading: headerStatus ? <TrackerStatusIcon status={headerStatus} size={18} /> : null,
    }),
    [headerStatus, headerTitle],
  );
  const footer = useMemo(
    () =>
      canGoBack ? (
        <TrackerDetailBackButton onBack={handleBack} disabled={actionState.status === "pending"} />
      ) : null,
    [canGoBack, handleBack, actionState.status],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      onDismiss={onClose}
      footer={footer}
      footerContainerStyle={styles.footerContainer}
      desktopMaxWidth={640}
      testID="tracker-detail-sheet"
    >
      {actionState.status === "error" ? (
        <Text accessibilityRole="alert" style={styles.message} testID="tracker-detail-action-error">
          {actionState.message}
        </Text>
      ) : null}
      {state.status === "loading" ? (
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
      {state.status === "loaded" && state.refreshError ? (
        <View>
          <Text accessibilityRole="alert" style={styles.message}>
            {state.refreshError}
          </Text>
          <Button variant="ghost" onPress={load} testID="tracker-detail-retry">
            Try again
          </Button>
        </View>
      ) : null}
      {state.status === "loaded" ? (
        <TrackerDetailContent
          tracker={state.tracker}
          noteBody={noteBody}
          noteInputRef={noteInputRef}
          onChangeNoteBody={setCurrentNoteDraft}
          onStart={start}
          onClose={close}
          onReopen={reopen}
          onCancel={cancel}
          onOpenChild={handleOpenChild}
          onAddNote={addNote}
          isAddingNote={mutations.isAddingNote}
          isPending={actionState.status === "pending"}
          isDetailLoaded={detail.data !== undefined}
        />
      ) : null}
    </AdaptiveModalSheet>
  );
}

function TrackerDetailContent({
  tracker,
  noteBody,
  noteInputRef,
  onChangeNoteBody,
  onStart,
  onClose,
  onReopen,
  onCancel,
  onOpenChild,
  onAddNote,
  isAddingNote,
  isPending,
  isDetailLoaded,
}: {
  tracker: TrackerDetail;
  noteBody: string;
  noteInputRef: RefObject<EditingTextInputHandle | null>;
  onChangeNoteBody: (value: string) => void;
  onStart: () => void;
  onClose: () => void;
  onReopen: () => void;
  onCancel: () => void;
  onOpenChild: (childId: string) => void;
  onAddNote: () => void;
  isAddingNote: boolean;
  isPending: boolean;
  isDetailLoaded: boolean;
}): ReactElement {
  const isOpenOrInProgress = tracker.status === "open" || tracker.status === "in_progress";
  const hasNoteBody = noteBody.trim().length > 0;
  const actionsDisabled = isPending || !isDetailLoaded;
  const notes = useMemo(
    () => [...tracker.notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [tracker.notes],
  );
  // `closedAt` is only ever set by `ait` for status `closed` — never for `cancelled`.
  const showClosedAt = tracker.status === "closed" && Boolean(tracker.closedAt);

  return (
    <View style={styles.content}>
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
      <Text style={styles.meta}>
        {trackerStatusLabel(tracker.status)} · {tracker.type} · {tracker.priority}
        {tracker.claimedBy ? ` · claimed by ${tracker.claimedBy}` : ""}
      </Text>
      {tracker.createdAt ? (
        <Text style={styles.dates}>
          {`Created ${formatTimeAgo(new Date(tracker.createdAt))}`}
          {showClosedAt && tracker.closedAt
            ? ` · Closed ${formatTimeAgo(new Date(tracker.closedAt))}`
            : ""}
        </Text>
      ) : null}

      {tracker.description ? <Text style={styles.description}>{tracker.description}</Text> : null}

      <TrackerDetailActions
        isOpenOrInProgress={isOpenOrInProgress}
        isOpen={tracker.status === "open"}
        onStart={onStart}
        onClose={onClose}
        onReopen={onReopen}
        onCancel={onCancel}
        isPending={actionsDisabled}
      />

      {tracker.children.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Children</Text>
          {tracker.children.map((child) => (
            <ChildTrackerLink
              key={child.id}
              child={child}
              onPress={onOpenChild}
              disabled={actionsDisabled}
            />
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
        {notes.length === 0 ? <Text style={styles.emptyNotes}>No notes yet.</Text> : null}
        {notes.map((note) => (
          <View key={note.id} style={styles.note}>
            <Text style={styles.noteBody}>{note.body}</Text>
            <Text style={styles.noteMeta}>{formatTimeAgo(new Date(note.createdAt))}</Text>
          </View>
        ))}
        <View style={styles.noteComposer}>
          <FormTextInput
            ref={noteInputRef}
            initialValue={noteBody}
            onChangeText={onChangeNoteBody}
            editable={!actionsDisabled}
            placeholder="Add a note"
            multiline
            testID="tracker-detail-note-input"
          />
          <Button
            variant={hasNoteBody ? "default" : "outline"}
            style={[styles.noteButtonSize, hasNoteBody && styles.addNoteButton]}
            size="sm"
            onPress={onAddNote}
            disabled={!hasNoteBody || actionsDisabled}
            loading={isAddingNote}
            testID="tracker-detail-add-note"
          >
            Add note
          </Button>
        </View>
      </View>
    </View>
  );
}

function TrackerDetailBackButton({
  onBack,
  disabled,
}: {
  onBack: () => void;
  disabled: boolean;
}): ReactElement {
  return (
    <View style={styles.backRow}>
      <Button
        variant="outline"
        size="sm"
        style={styles.backButton}
        onPress={onBack}
        disabled={disabled}
        testID="tracker-detail-back"
      >
        Back
      </Button>
    </View>
  );
}

function TrackerDetailActions({
  isOpenOrInProgress,
  isOpen,
  onStart,
  onClose,
  onReopen,
  onCancel,
  isPending,
}: {
  isOpenOrInProgress: boolean;
  isOpen: boolean;
  onStart: () => void;
  onClose: () => void;
  onReopen: () => void;
  onCancel: () => void;
  isPending: boolean;
}): ReactElement {
  return (
    <View style={styles.actionsRow}>
      {isOpen ? (
        <Button
          variant="outline"
          size="sm"
          textStyle={styles.actionInProgress}
          hoverStyle={styles.actionInProgressHover}
          onPress={onStart}
          disabled={isPending}
          loading={isPending}
          testID="tracker-detail-start"
        >
          Start
        </Button>
      ) : null}
      {isOpenOrInProgress ? (
        <Button
          variant="outline"
          size="sm"
          textStyle={styles.actionClosed}
          hoverStyle={styles.actionClosedHover}
          onPress={onClose}
          disabled={isPending}
          testID="tracker-detail-close"
        >
          Close
        </Button>
      ) : null}
      {!isOpenOrInProgress ? (
        <Button
          variant="outline"
          size="sm"
          textStyle={styles.actionOpen}
          hoverStyle={styles.actionOpenHover}
          onPress={onReopen}
          disabled={isPending}
          testID="tracker-detail-reopen"
        >
          Reopen
        </Button>
      ) : null}
      {isOpenOrInProgress ? (
        <Button
          variant="ghost"
          size="sm"
          textStyle={styles.actionCancel}
          hoverStyle={styles.actionCancelHover}
          onPress={onCancel}
          disabled={isPending}
          testID="tracker-detail-cancel"
        >
          Cancel
        </Button>
      ) : null}
    </View>
  );
}

function ChildTrackerLink({
  child,
  onPress,
  disabled,
}: {
  child: TrackerSummary;
  onPress: (childId: string) => void;
  disabled: boolean;
}): ReactElement {
  const [hovered, setHovered] = useState(false);
  const handlePress = useCallback(() => onPress(child.id), [child.id, onPress]);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);
  const accessibilityState = useMemo(() => ({ disabled }), [disabled]);

  return (
    <Pressable
      accessibilityLabel={`Open child ${child.id}`}
      accessibilityRole="button"
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      onPress={handlePress}
      disabled={disabled}
      accessibilityState={accessibilityState}
    >
      <View style={styles.childLinkRow}>
        <View style={styles.childLinkIcon}>
          <TrackerStatusIcon status={child.status} size={12} colorize />
        </View>
        <Text style={[styles.listItem, hovered && styles.listItemHovered]} numberOfLines={1}>
          {child.id} · {child.title}
        </Text>
      </View>
    </Pressable>
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
  dates: {
    color: theme.colors.foregroundExtraMuted,
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
  actionOpen: {
    color: theme.colors.palette.blue[600],
  },
  actionInProgress: {
    color: theme.colors.palette.blue[600],
  },
  actionClosed: {
    color: theme.colors.palette.green[600],
  },
  actionOpenHover: {
    borderColor: theme.colors.palette.blue[600],
    backgroundColor: theme.colors.surface2,
  },
  actionInProgressHover: {
    borderColor: theme.colors.palette.blue[600],
    backgroundColor: theme.colors.surface2,
  },
  actionClosedHover: {
    borderColor: theme.colors.palette.green[600],
    backgroundColor: theme.colors.surface2,
  },
  actionCancel: {
    color: theme.colors.statusDanger,
  },
  actionCancelHover: {
    backgroundColor: theme.colors.surface2,
  },
  section: {
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[4],
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
  },
  listItem: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flex: 1,
  },
  childLinkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  childLinkIcon: {
    marginTop: 3,
  },
  listItemHovered: {
    color: theme.colors.accent,
  },
  emptyNotes: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  note: {
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  noteComposer: {
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  addNoteButton: {
    backgroundColor: theme.colors.palette.green[600],
    borderColor: theme.colors.palette.green[600],
    borderWidth: 1,
  },
  noteButtonSize: {
    paddingVertical: theme.spacing[3],
  },
  noteBody: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  noteMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  footerContainer: {
    borderTopWidth: 0,
    paddingTop: 0,
  },
  backRow: {
    flex: 1,
  },
  backButton: {
    width: "100%",
    minHeight: 38,
  },
}));
