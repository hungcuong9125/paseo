import { describe, expect, it } from "vitest";
import {
  getTrackerPageCount,
  getTrackerPageItems,
  getTrackerPageSlice,
  TRACKER_PAGE_SIZE,
} from "./tracker-pagination";

describe("tracker pagination", () => {
  it("keeps up to 20 items on one page", () => {
    expect(getTrackerPageCount(20)).toBe(1);
    expect(
      getTrackerPageSlice(
        Array.from({ length: 20 }, (_, index) => index),
        1,
      ),
    ).toEqual(Array.from({ length: 20 }, (_, index) => index));
  });

  it("splits items into pages of 20", () => {
    const items = Array.from({ length: TRACKER_PAGE_SIZE + 2 }, (_, index) => index);

    expect(getTrackerPageCount(items.length)).toBe(2);
    expect(getTrackerPageSlice(items, 2)).toEqual([20, 21]);
  });

  it("clamps a page outside the available range", () => {
    const items = ["one", "two", "three"];

    expect(getTrackerPageSlice(items, 0)).toEqual(items);
    expect(getTrackerPageSlice(items, 99)).toEqual(items);
  });

  it("shows all page numbers for a short pagination range", () => {
    expect(getTrackerPageItems(5, 3)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the first and last pages visible for a long range", () => {
    expect(getTrackerPageItems(12, 6)).toEqual([1, "ellipsis", 5, 6, 7, "ellipsis", 12]);
    expect(getTrackerPageItems(12, 2)).toEqual([1, 2, 3, 4, 5, "ellipsis", 12]);
    expect(getTrackerPageItems(12, 11)).toEqual([1, "ellipsis", 8, 9, 10, 11, 12]);
  });
});
