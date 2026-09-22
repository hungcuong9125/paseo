import { Circle, CircleCheck, CircleDot, CircleX } from "lucide-react-native";
import type { ReactElement } from "react";
import { withUnistyles } from "react-native-unistyles";
import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";
import type { Theme } from "@/styles/theme";

// Mirrors packages/app/src/components/task-list-row.tsx — same concept (a list
// of tasks with pending/running/completed states), same icon + colour
// language, so Tracker reads as the same product instead of inventing a
// second status vocabulary. `cancelled` has no equivalent there; it borrows
// the same treatment as `closed` (extra-muted, struck through) but with the
// danger token, since it's also terminal but not a success.
const ThemedCircle = withUnistyles(Circle);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleX = withUnistyles(CircleX);

const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const extraMutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const openIcon = (theme: Theme) => ({ color: theme.colors.palette.blue[600] });
const inProgressIcon = (theme: Theme) => ({ color: theme.colors.palette.amber[700] });
const closedIcon = (theme: Theme) => ({ color: theme.colors.palette.green[600] });
const cancelledIcon = (theme: Theme) => ({ color: theme.colors.palette.red[600] });

function getIconColor(status: TrackerSummary["status"], colorize: boolean) {
  if (!colorize) {
    return status === "closed" || status === "cancelled" ? extraMutedIcon : mutedIcon;
  }
  switch (status) {
    case "open":
      return openIcon;
    case "in_progress":
      return inProgressIcon;
    case "closed":
      return closedIcon;
    case "cancelled":
      return cancelledIcon;
  }
}

export function TrackerStatusIcon({
  status,
  size = 16,
  colorize = false,
}: {
  status: TrackerSummary["status"];
  size?: number;
  colorize?: boolean;
}): ReactElement {
  const iconColor = getIconColor(status, colorize);
  switch (status) {
    case "open":
      return <ThemedCircle size={size} uniProps={iconColor} />;
    case "in_progress":
      return <ThemedCircleDot size={size} uniProps={iconColor} />;
    case "closed":
      return <ThemedCircleCheck size={size} uniProps={iconColor} />;
    case "cancelled":
      return <ThemedCircleX size={size} uniProps={iconColor} />;
  }
}

export function trackerStatusLabel(status: TrackerSummary["status"]): string {
  switch (status) {
    case "open":
      return "Open";
    case "in_progress":
      return "In progress";
    case "closed":
      return "Closed";
    case "cancelled":
      return "Cancelled";
  }
}
