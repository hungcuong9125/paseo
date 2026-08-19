import { useMemo } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export type StatusBadgeVariant = "success" | "error" | "warning" | "muted" | "open";

interface StatusBadgeProps {
  label: string;
  variant?: StatusBadgeVariant;
}

export function StatusBadge({ label, variant = "muted" }: StatusBadgeProps) {
  const pillStyle = useMemo(
    () => [
      styles.pill,
      variant === "muted" && styles.pillMuted,
      variant === "open" && styles.pillOpen,
      variant === "success" && styles.pillSuccess,
      variant === "error" && styles.pillError,
      variant === "warning" && styles.pillWarning,
    ],
    [variant],
  );
  const textStyle = useMemo(
    () => [
      styles.pillText,
      variant === "success" && styles.pillTextSuccess,
      variant === "error" && styles.pillTextError,
      variant === "warning" && styles.pillTextWarning,
    ],
    [variant],
  );

  return (
    <View style={pillStyle}>
      <Text style={textStyle}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: theme.borderRadius.full,
    borderWidth: 0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
  },
  // Borderless soft tints (Linear/Tailwind style). Borders are dropped entirely —
  // alpha-suffixed border colors fall back to black in this RN/Unistyles build, so a
  // tint background alone carries the status. `33` is the 20% alpha suffix the
  // identity table uses; backgrounds take alpha, borders take none.
  pillMuted: {
    backgroundColor: theme.colors.surface3,
  },
  pillOpen: {
    backgroundColor: "transparent",
  },
  pillSuccess: {
    backgroundColor: `${theme.colors.statusSuccess}33`,
  },
  pillError: {
    backgroundColor: `${theme.colors.statusDanger}33`,
  },
  pillWarning: {
    backgroundColor: `${theme.colors.statusWarning}33`,
  },
  pillText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  pillTextSuccess: {
    color: theme.colors.statusSuccess,
  },
  pillTextError: {
    color: theme.colors.statusDanger,
  },
  pillTextWarning: {
    color: theme.colors.statusWarning,
  },
  pillTextOpen: {
    color: theme.colors.palette.blue,
  },
}));
