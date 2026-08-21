import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { AggregatedTracker } from "@/tracker/aggregated-trackers";
import { useTrackerMutations } from "@/tracker/use-tracker-mutations";
import { toErrorMessage } from "@/utils/error-messages";

// Plain literal, not a unistyles `StyleSheet.create` entry — see the usage
// site's comment for why.
const DESCRIPTION_INPUT_STYLE = { minHeight: 420 };

export interface TrackerEditSheetProps {
  tracker: AggregatedTracker | null;
  visible: boolean;
  onClose: () => void;
  /** Fires with the mutation's own response after the update succeeds — the
   * caller patches its shared data hook in place so the view behind this
   * sheet reflects the change without a re-fetch. */
  onUpdated: (tracker: TrackerSummary) => void;
}

// Two-level mount so the sheet's exit animation keeps rendering the form that was open
// when the parent flipped `visible` to false, instead of unmounting mid-animation.
export function TrackerEditSheet(props: TrackerEditSheetProps): ReactElement | null {
  const [renderedProps, setRenderedProps] = useState<TrackerEditSheetProps | null>(() =>
    props.visible ? props : null,
  );
  const [sheetVisible, setSheetVisible] = useState(props.visible);
  const livePropsRef = useRef(props);
  const closeRequestedRef = useRef(false);
  livePropsRef.current = props;

  useEffect(() => {
    if (props.visible) {
      if (closeRequestedRef.current) {
        return;
      }
      setRenderedProps(props);
      setSheetVisible(true);
      return;
    }
    if (renderedProps) {
      setSheetVisible(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible]);

  const requestClose = useCallback(() => {
    closeRequestedRef.current = true;
    setSheetVisible(false);
  }, []);

  const handleDismiss = useCallback(() => {
    const dismissedProps = livePropsRef.current;
    closeRequestedRef.current = false;
    setRenderedProps(null);
    setSheetVisible(false);
    if (dismissedProps.visible) {
      dismissedProps.onClose();
    }
  }, []);

  if (!renderedProps?.tracker) {
    return null;
  }

  return (
    <OpenTrackerEditSheet
      key={renderedProps.tracker.id}
      tracker={renderedProps.tracker}
      visible={sheetVisible}
      onClose={requestClose}
      onDismiss={handleDismiss}
      onUpdated={renderedProps.onUpdated}
    />
  );
}

function OpenTrackerEditSheet({
  tracker,
  visible,
  onClose,
  onDismiss,
  onUpdated,
}: Omit<TrackerEditSheetProps, "tracker"> & {
  tracker: AggregatedTracker;
  onDismiss: () => void;
}): ReactElement {
  const client = useHostRuntimeClient(tracker.serverId);
  const [title, setTitle] = useState(tracker.title);
  const [description, setDescription] = useState("");
  // `AdaptiveTextInput` is intentionally uncontrolled (see its own docstring) —
  // it renders `initialValue`/`defaultValue` once and ignores later `value`
  // changes, remounting only when `resetKey` changes. The description arrives
  // asynchronously after mount, so its field needs a resetKey flip once the
  // fetch resolves; the title needs none since it's known synchronously.
  const [descriptionLoadState, setDescriptionLoadState] = useState<"loading" | "loaded">("loading");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { updateTracker, isUpdating } = useTrackerMutations({
    serverId: tracker.serverId,
    projectId: tracker.projectId,
  });

  // Summaries don't carry `description` — fetch the full record once to prefill
  // the field. Title prefills synchronously above. A failed prefill only shows
  // a notice; an untouched description submits as omitted, which leaves the
  // stored value unchanged rather than wiping it.
  useEffect(() => {
    let cancelled = false;
    async function loadDescription(): Promise<void> {
      if (!client) {
        setLoadError("Host disconnected");
        setDescriptionLoadState("loaded");
        return;
      }
      try {
        const detail = await client.trackerShow({
          projectId: tracker.projectId,
          trackerId: tracker.id,
        });
        if (!cancelled) {
          setDescription(detail.description ?? "");
          setDescriptionLoadState("loaded");
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(toErrorMessage(error));
          setDescriptionLoadState("loaded");
        }
      }
    }
    void loadDescription();
    return () => {
      cancelled = true;
    };
  }, [client, tracker.id, tracker.projectId]);

  const canSubmit = title.trim().length > 0 && !isUpdating;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    setSubmitError(null);
    try {
      const summary = await updateTracker({
        trackerId: tracker.id,
        title: title.trim(),
        description: description.trim() || undefined,
      });
      onUpdated(summary);
      onClose();
    } catch (error) {
      setSubmitError(toErrorMessage(error));
    }
  }, [canSubmit, updateTracker, tracker.id, title, description, onUpdated, onClose]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const header = useMemo<SheetHeader>(() => ({ title: "Edit item" }), []);

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button style={styles.footerButton} variant="secondary" onPress={onClose}>
          Cancel
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSubmitPress}
          disabled={!canSubmit}
          loading={isUpdating}
          testID="tracker-edit-submit"
        >
          Save
        </Button>
      </View>
    ),
    [canSubmit, handleSubmitPress, isUpdating, onClose],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      footer={footer}
      desktopMaxWidth={640}
      testID="tracker-edit-sheet"
    >
      <Field label="Title" testID="tracker-edit-title">
        <FormTextInput
          initialValue={title}
          onChangeText={setTitle}
          placeholder="What needs doing?"
          autoFocus
        />
      </Field>
      <Field label="Description" testID="tracker-edit-description">
        <FormTextInput
          initialValue={description}
          resetKey={descriptionLoadState}
          onChangeText={setDescription}
          placeholder="Optional details"
          multiline
          textAlignVertical="top"
          // Plain inline object, not a `styles.create(...)` (unistyles) entry:
          // `FormTextInput` flattens the caller's `style` prop internally to
          // split text-only properties from the chrome wrapper's, and
          // flattening a unistyles style loses its `unistyles_*` metadata
          // (see docs/unistyles.md's "do not flatten a caller-provided style"
          // note) — a themeless literal here sidesteps that entirely.
          style={DESCRIPTION_INPUT_STYLE}
        />
      </Field>
      {loadError ? (
        <Text style={styles.errorText} testID="tracker-edit-load-error">
          Couldn&apos;t load the current description: {loadError}
        </Text>
      ) : null}
      {submitError ? (
        <Text style={styles.errorText} testID="tracker-edit-error">
          {submitError}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  footerButton: {
    flex: 1,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
