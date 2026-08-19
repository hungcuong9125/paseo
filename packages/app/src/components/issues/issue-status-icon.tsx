import { Circle, CircleCheck, CircleDot, CircleX } from "lucide-react-native";
import type { ReactElement } from "react";
import { withUnistyles } from "react-native-unistyles";
import type { IssueSummary } from "@getpaseo/protocol/issues/types";
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

export function IssueStatusIcon({
  status,
  size = 16,
}: {
  status: IssueSummary["status"];
  size?: number;
}): ReactElement {
  switch (status) {
    case "open":
      return <ThemedCircle size={size} uniProps={mutedIcon} />;
    case "in_progress":
      return <ThemedCircleDot size={size} uniProps={mutedIcon} />;
    case "closed":
      return <ThemedCircleCheck size={size} uniProps={extraMutedIcon} />;
    case "cancelled":
      return <ThemedCircleX size={size} uniProps={extraMutedIcon} />;
  }
}

export function issueStatusLabel(status: IssueSummary["status"]): string {
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
