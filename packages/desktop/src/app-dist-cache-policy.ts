/**
 * Whether a path served through the `paseo://app` protocol handler must
 * never be cached, keyed on the path relative to `appDistDir`. Every hashed
 * Expo static asset is safe to cache indefinitely by omission (a new build
 * never reuses an old asset's URL) — only the unhashed entrypoint files that
 * NAME those assets need `no-store`, or a build's index.html can outlive the
 * build itself in Chromium's disk cache: the app relaunches on a freshly
 * installed Paseo.app, but the SAME `paseo://app/` URL keeps resolving to
 * whichever index.html first got cached, with no error and no visible sign
 * that anything is stale.
 */
export function shouldNoStoreAppDistPath(relativePath: string): boolean {
  return relativePath === "" || relativePath === "index.html" || relativePath === "manifest.json";
}
