import { describe, expect, it } from "vitest";
import { shouldNoStoreAppDistPath } from "./app-dist-cache-policy.js";

describe("shouldNoStoreAppDistPath", () => {
  it("marks the SPA fallback (empty relative path) as never-cache", () => {
    expect(shouldNoStoreAppDistPath("")).toBe(true);
  });

  it("marks index.html as never-cache", () => {
    expect(shouldNoStoreAppDistPath("index.html")).toBe(true);
  });

  it("marks manifest.json as never-cache", () => {
    expect(shouldNoStoreAppDistPath("manifest.json")).toBe(true);
  });

  it("leaves a hashed Expo static asset free to cache", () => {
    expect(shouldNoStoreAppDistPath("_expo/static/js/web/index-0ee3384ce481.js")).toBe(false);
  });

  it("leaves unhashed static assets other than the entrypoint files free to cache", () => {
    expect(shouldNoStoreAppDistPath("favicon.ico")).toBe(false);
    expect(shouldNoStoreAppDistPath("apple-touch-icon.png")).toBe(false);
  });

  it("does not treat a nested file merely named index.html as the SPA entrypoint", () => {
    // path.relative always returns a path relative to appDistDir, so a route
    // like /docs/index.html would show up here as "docs/index.html" — this
    // function's job is exact-match on the entrypoint's own relative path,
    // not a suffix check that could quietly widen the no-store set.
    expect(shouldNoStoreAppDistPath("docs/index.html")).toBe(false);
  });
});
