export const TRACKER_PAGE_SIZE = 20;
export const TRACKER_PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
export type TrackerPageSize = (typeof TRACKER_PAGE_SIZE_OPTIONS)[number];

export type TrackerPaginationItem = number | "ellipsis";

export function getTrackerPageCount(totalItems: number, pageSize = TRACKER_PAGE_SIZE): number {
  if (totalItems <= 0) {
    return 1;
  }
  return Math.ceil(totalItems / pageSize);
}

export function getTrackerPageItems(
  totalPages: number,
  currentPage: number,
): TrackerPaginationItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  if (currentPage <= 4) {
    return [1, 2, 3, 4, 5, "ellipsis", totalPages];
  }

  if (currentPage >= totalPages - 3) {
    return [
      1,
      "ellipsis",
      totalPages - 4,
      totalPages - 3,
      totalPages - 2,
      totalPages - 1,
      totalPages,
    ];
  }

  return [1, "ellipsis", currentPage - 1, currentPage, currentPage + 1, "ellipsis", totalPages];
}

export function getTrackerPageSlice<T>(
  items: readonly T[],
  currentPage: number,
  pageSize = TRACKER_PAGE_SIZE,
): T[] {
  const pageCount = getTrackerPageCount(items.length, pageSize);
  const safePage = Math.min(Math.max(currentPage, 1), pageCount);
  const start = (safePage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
