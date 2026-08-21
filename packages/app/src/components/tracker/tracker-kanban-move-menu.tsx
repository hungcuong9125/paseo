import { memo, useCallback, useMemo, type PropsWithChildren, type ReactElement } from "react";
import { MoreVertical } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuItem, MenuSeparator } from "@/components/ui/menu";
import { laneTranslationKey } from "@/components/tracker/tracker-kanban-column";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import {
  getTrackerTransition,
  type TrackerLane,
  type TrackerTransition,
} from "@/tracker/tracker-transitions";

// UNKNOWN 3 resolution: the DnD spike for cross-container drop on RN-web was not
// empirically verified in this environment (no browser-automation tool was
// available to drive a real drag gesture), so this ships the plan's own
// contingency — the shared "Move to..." menu — on every platform rather than
// leaving web with no way to move a card. See the board component's report for
// detail; drag-and-drop remains open for a follow-up spike with real browser
// tooling.

const ALL_LANES: readonly TrackerLane[] = ["open", "in_progress", "done", "cancelled"];

export interface TrackerKanbanTransitionOption {
  to: TrackerLane;
  transition: TrackerTransition;
}

// Enumerates the shared transition matrix (tracker-transitions.ts) for a lane —
// never redeclares which pairs are valid, only reads the answer.
export function availableTrackerTransitions(lane: TrackerLane): TrackerKanbanTransitionOption[] {
  return ALL_LANES.flatMap((to) => {
    const transition = getTrackerTransition(lane, to);
    return transition ? [{ to, transition }] : [];
  });
}

const ThemedKebab = withUnistyles(MoreVertical);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

function renderKebabIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return <ThemedKebab size={14} uniProps={hovered ? foregroundColorMapping : mutedColorMapping} />;
}

interface TrackerKanbanMoveItemProps {
  trackerId: string;
  transition: TrackerTransition;
  label: string;
  isPending: boolean;
  onTransition: (trackerId: string, transition: TrackerTransition) => void;
  testID?: string;
}

// `ContextMenuItem`/`DropdownMenuItem` are the same `MenuItem` re-exported under two
// names (see context-menu.tsx / dropdown-menu.tsx), so one item component renders
// correctly inside either surface's content. Its own `onSelect` is memoized per
// (trackerId, transition) instead of allocating a closure inline in the list below.
const TrackerKanbanMoveItem = memo(function TrackerKanbanMoveItem({
  trackerId,
  transition,
  label,
  isPending,
  onTransition,
  testID,
}: TrackerKanbanMoveItemProps): ReactElement {
  const handleSelect = useCallback(
    () => onTransition(trackerId, transition),
    [onTransition, trackerId, transition],
  );
  return (
    <MenuItem disabled={isPending} onSelect={handleSelect} testID={testID}>
      {label}
    </MenuItem>
  );
});

interface TrackerKanbanEditItemProps {
  trackerId: string;
  /** Omit to hide the Edit entry entirely (callers/tests that don't wire editing). */
  onEdit?: (trackerId: string) => void;
  testID?: string;
}

// The static Edit entry rendered above the "Move to..." list on both surfaces.
// Same per-(trackerId, handler) memoization rationale as TrackerKanbanMoveItem.
const TrackerKanbanEditItems = memo(function TrackerKanbanEditItems({
  trackerId,
  onEdit,
  testID,
}: TrackerKanbanEditItemProps): ReactElement | null {
  const handleSelect = useCallback(() => onEdit?.(trackerId), [onEdit, trackerId]);
  if (!onEdit) {
    return null;
  }
  return (
    <>
      <MenuItem onSelect={handleSelect} testID={testID}>
        Edit
      </MenuItem>
      <MenuSeparator />
    </>
  );
});

export interface TrackerKanbanCardMenuProps {
  trackerId: string;
  trackerTitle: string;
  lane: TrackerLane;
  isPending: boolean;
  onTransition: (trackerId: string, transition: TrackerTransition) => void;
  /** Opens the caller's edit sheet for this card — no mutation happens until that sheet submits. */
  onEdit?: (trackerId: string) => void;
  /**
   * Tapping the card body (not long-press, not the kebab). Native passes this straight
   * to `ContextMenuTrigger`'s own `onPress` — RN's core `Pressable` natively combines
   * `onPress` and `onLongPress` on one component — instead of nesting a second Pressable
   * inside it, which would leave two Pressables racing over the same touch responder.
   */
  onCardPress?: (trackerId: string) => void;
  /** testID prefix — item ids append `-item-${to}`, the kebab trigger appends `-trigger`. */
  testID?: string;
}

/**
 * The shared "Move to..." action sheet. Wraps `children` (the card body):
 * - Native (every width): long-press on the card body opens it, via `ContextMenu`; a plain
 *   tap fires `onCardPress` — both live on the same `ContextMenuTrigger`/`Pressable`, never
 *   on nested Pressables.
 * - Every platform: a kebab button always renders the same options via `DropdownMenu`,
 *   which is also the screen-reader-reachable path and the web fallback for moving a
 *   card while drag-and-drop is unshipped.
 *
 * Both triggers read the same transition list, built once from tracker-transitions.ts,
 * so the two surfaces can never disagree about what moves are available.
 */
export function TrackerKanbanCardMenu({
  children,
  trackerId,
  trackerTitle,
  lane,
  isPending,
  onTransition,
  onEdit,
  onCardPress,
  testID,
}: PropsWithChildren<TrackerKanbanCardMenuProps>): ReactElement {
  const { t } = useTranslation();
  const options = useMemo(() => availableTrackerTransitions(lane), [lane]);
  const triggerLabel = t("tracker.kanban.moveMenu.trigger", { title: trackerTitle });
  const sheetTitle = t("tracker.kanban.moveMenu.title");
  const handleCardPress = useCallback(() => {
    onCardPress?.(trackerId);
  }, [onCardPress, trackerId]);

  return (
    <View style={styles.wrapper}>
      {isNative ? (
        <ContextMenu>
          <ContextMenuTrigger
            enabledOnWeb={false}
            disabled={isPending}
            accessibilityLabel={triggerLabel}
            onPress={handleCardPress}
          >
            {children}
          </ContextMenuTrigger>
          <ContextMenuContent sheetTitle={sheetTitle} width={220}>
            <TrackerKanbanEditItems
              trackerId={trackerId}
              onEdit={onEdit}
              testID={testID ? `${testID}-context-item-edit` : undefined}
            />
            {options.map(({ to, transition }) => (
              <TrackerKanbanMoveItem
                key={to}
                trackerId={trackerId}
                transition={transition}
                label={t(`tracker.kanban.moveTo.${laneTranslationKey(to)}`)}
                isPending={isPending}
                onTransition={onTransition}
                testID={testID ? `${testID}-context-item-${to}` : undefined}
              />
            ))}
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        children
      )}
      <View style={[styles.kebabOverlay, isPending && styles.kebabOverlayPending]}>
        <DropdownMenu compactMode="sheet">
          <DropdownMenuTrigger
            hitSlop={8}
            style={styles.kebabTrigger}
            disabled={isPending}
            accessibilityRole="button"
            accessibilityLabel={triggerLabel}
            testID={testID ? `${testID}-trigger` : undefined}
          >
            {renderKebabIcon}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sheetTitle={sheetTitle} width={220}>
            <TrackerKanbanEditItems
              trackerId={trackerId}
              onEdit={onEdit}
              testID={testID ? `${testID}-item-edit` : undefined}
            />
            {options.map(({ to, transition }) => (
              <TrackerKanbanMoveItem
                key={to}
                trackerId={trackerId}
                transition={transition}
                label={t(`tracker.kanban.moveTo.${laneTranslationKey(to)}`)}
                isPending={isPending}
                onTransition={onTransition}
                testID={testID ? `${testID}-item-${to}` : undefined}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrapper: {
    position: "relative",
  },
  kebabOverlay: {
    position: "absolute",
    top: theme.spacing[1],
    right: theme.spacing[1],
  },
  kebabOverlayPending: {
    opacity: 0.5,
  },
  kebabTrigger: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
}));
