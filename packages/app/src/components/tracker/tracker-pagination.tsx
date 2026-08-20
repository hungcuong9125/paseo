import {
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react-native";
import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  getTrackerPageItems,
  TRACKER_PAGE_SIZE_OPTIONS,
  type TrackerPageSize,
} from "@/tracker/tracker-pagination";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Theme } from "@/styles/theme";

const ThemedChevronsLeft = withUnistyles(ChevronsLeft);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronsRight = withUnistyles(ChevronsRight);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface TrackerPaginationProps {
  currentPage: number;
  totalItems: number;
  totalPages: number;
  pageSize: TrackerPageSize;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: TrackerPageSize) => void;
}

export function TrackerPagination({
  currentPage,
  totalItems,
  totalPages,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: TrackerPaginationProps): ReactElement {
  const startItem = (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(currentPage * pageSize, totalItems);
  const pageItems = getTrackerPageItems(totalPages, currentPage);
  const handleFirstPage = useCallback(() => onPageChange(1), [onPageChange]);
  const handlePreviousPage = useCallback(
    () => onPageChange(currentPage - 1),
    [currentPage, onPageChange],
  );
  const handleNextPage = useCallback(
    () => onPageChange(currentPage + 1),
    [currentPage, onPageChange],
  );
  const handleLastPage = useCallback(() => onPageChange(totalPages), [onPageChange, totalPages]);

  return (
    <View style={styles.pagination} testID="tracker-pagination">
      <View style={styles.summaryWrap}>
        <Text style={styles.summary}>{`Showing ${startItem}-${endItem} of ${totalItems}`}</Text>
      </View>
      <View style={styles.controls}>
        <PageIconButton
          label="Go to first page"
          disabled={currentPage === 1}
          onPress={handleFirstPage}
        >
          <ThemedChevronsLeft size={16} uniProps={mutedColorMapping} />
        </PageIconButton>
        <PageIconButton
          label="Go to previous page"
          disabled={currentPage === 1}
          onPress={handlePreviousPage}
        >
          <ThemedChevronLeft size={16} uniProps={mutedColorMapping} />
        </PageIconButton>
        <View style={styles.pageNumbers}>
          {pageItems.map((item, pageIndex) =>
            item === "ellipsis" ? (
              <Text
                key={`ellipsis-${pageIndex === 1 ? "before" : "after"}`}
                style={styles.ellipsis}
              >
                ...
              </Text>
            ) : (
              <PageNumberButton
                key={item}
                page={item}
                active={item === currentPage}
                onPress={onPageChange}
              />
            ),
          )}
        </View>
        <PageIconButton
          label="Go to next page"
          disabled={currentPage === totalPages}
          onPress={handleNextPage}
        >
          <ThemedChevronRight size={16} uniProps={mutedColorMapping} />
        </PageIconButton>
        <PageIconButton
          label="Go to last page"
          disabled={currentPage === totalPages}
          onPress={handleLastPage}
        >
          <ThemedChevronsRight size={16} uniProps={mutedColorMapping} />
        </PageIconButton>
      </View>
      <View style={styles.pageSizeWrap}>
        <Text style={styles.pageSizeLabel}>Rows per page</Text>
        <DropdownMenu>
          <DropdownMenuTrigger style={styles.pageSizeTrigger} accessibilityLabel="Rows per page">
            <Text style={styles.pageSizeText}>{`${pageSize} / page`}</Text>
            <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width={120}>
            {TRACKER_PAGE_SIZE_OPTIONS.map((option) => (
              <PageSizeMenuItem
                key={option}
                option={option}
                selected={option === pageSize}
                onSelect={onPageSizeChange}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    </View>
  );
}

function PageSizeMenuItem({
  onSelect,
  option,
  selected,
}: {
  onSelect: (pageSize: TrackerPageSize) => void;
  option: TrackerPageSize;
  selected: boolean;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(option), [onSelect, option]);

  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {`${option} / page`}
    </DropdownMenuItem>
  );
}

function PageIconButton({
  children,
  disabled,
  label,
  onPress,
}: {
  children: ReactNode;
  disabled: boolean;
  label: string;
  onPress: () => void;
}): ReactElement {
  const accessibilityState = useMemo(() => ({ disabled }), [disabled]);
  const buttonStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.iconButton,
      pressed && styles.buttonPressed,
      disabled && styles.buttonDisabled,
    ],
    [disabled],
  );

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={onPress}
      style={buttonStyle}
    >
      {children}
    </Pressable>
  );
}

function PageNumberButton({
  active,
  onPress,
  page,
}: {
  active: boolean;
  onPress: (page: number) => void;
  page: number;
}): ReactElement {
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  const handlePress = useCallback(() => onPress(page), [onPress, page]);
  const buttonStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.pageButton,
      active && styles.pageButtonActive,
      pressed && !active && styles.buttonPressed,
    ],
    [active],
  );

  return (
    <Pressable
      accessibilityLabel={`Go to page ${page}`}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      style={buttonStyle}
    >
      <Text style={[styles.pageText, active && styles.pageTextActive]}>{page}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  pagination: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: 0,
    minHeight: 64,
  },
  summaryWrap: {
    position: "absolute",
    left: { xs: theme.spacing[3], md: theme.spacing[6] },
    top: 0,
    bottom: 0,
    justifyContent: "center",
    maxWidth: 150,
  },
  summary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  pageSizeWrap: {
    position: "absolute",
    right: { xs: theme.spacing[3], md: theme.spacing[6] },
    top: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  pageSizeLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  pageSizeTrigger: {
    minWidth: 88,
    height: 32,
    paddingHorizontal: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
  },
  pageSizeText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexWrap: "wrap",
    justifyContent: "center",
    maxWidth: "100%",
  },
  pageNumbers: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexWrap: "wrap",
    justifyContent: "center",
  },
  iconButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  pageButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  pageButtonActive: {
    backgroundColor: theme.colors.surface3,
  },
  pageText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  pageTextActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  ellipsis: {
    width: 24,
    textAlign: "center",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  buttonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  buttonDisabled: {
    opacity: theme.opacity[50],
  },
}));
