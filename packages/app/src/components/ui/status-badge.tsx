import React, { useMemo, type ReactNode } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export type StatusBadgeVariant = "success" | "warning" | "error" | "muted";
type StatusBadgeSize = "sm" | "md";

interface StatusBadgeProps {
  label: string;
  variant?: StatusBadgeVariant;
  leading?: ReactNode;
  size?: StatusBadgeSize;
}

export function StatusBadge({ label, variant = "muted", leading, size = "md" }: StatusBadgeProps) {
  const pillStyle = useMemo(
    () => [
      styles.pill,
      size === "sm" && styles.pillSmall,
      variant === "success" && styles.pillSuccess,
      variant === "error" && styles.pillError,
    ],
    [variant, size],
  );
  const textStyle = useMemo(
    () => [
      styles.pillText,
      size === "sm" && styles.pillTextSmall,
      variant === "success" && styles.pillTextSuccess,
      variant === "warning" && styles.pillTextWarning,
      variant === "error" && styles.pillTextError,
    ],
    [variant, size],
  );

  return (
    <View style={pillStyle}>
      {leading}
      <Text style={textStyle}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface3,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
  },
  pillSmall: {
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 1,
  },
  // Tinted from the one status token rather than a palette step, so the pill tracks the
  // theme. `1a`/`33` are the 10%/20% alpha suffixes the identity table uses.
  pillSuccess: {
    backgroundColor: `${theme.colors.statusSuccess}1a`,
    borderColor: `${theme.colors.statusSuccess}33`,
  },
  pillError: {
    backgroundColor: `${theme.colors.statusDanger}1a`,
    borderColor: `${theme.colors.statusDanger}33`,
  },
  pillText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  pillTextSmall: {
    fontSize: 10,
  },
  pillTextSuccess: {
    color: theme.colors.statusSuccess,
  },
  pillTextWarning: {
    color: theme.colors.statusWarning,
  },
  pillTextError: {
    color: theme.colors.statusDanger,
  },
}));
