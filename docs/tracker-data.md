# Tracker data loading and counting

The Tracker screen never pulls a project's whole `.ait/ait.db` over the WebSocket. It reads pages and server-computed counts through the daemon, which holds the full snapshot in `TrackerSyncManager`.

## Why the daemon reads and the client receives aggregates

An `ait` invocation costs roughly 13 ms on the daemon host; shipping every row to a phone over the relay is the expensive part. The daemon runs `ait` locally and sends only what the screen shows: one page of rows per (project, status) section, plus the totals.

`ait list --limit` returns `total_count` scoped to the request's filters, so a page carries its own total and no counts cache is needed. The stats RPC does not shell out again: it derives every bucket in `getTrackerStatsCounts` from the snapshot the manager already holds. `ait status` would be cheaper still, but it cannot break counts down per type, which is what the toolbar's type filter needs. The stats RPC is gated on `server_info.features.aitTrackerStats`; a daemon that predates it reports none and the toolbar pills fall back to the loaded-so-far count.

## Pagination

`useTrackerProjectData` loads the first page of `project.tracker.list` for each in-scope project × status section, and nothing more until `loadMore(status)` pages one more row-set per project. Counts come from each page's `pageInfo.totalCount`, summed across projects per section into `sectionTotals`.

When a project reports no total — an old CLI binary, an offline host, or a fetch error — that section's total is `null` and the screen renders the loaded-so-far count (`trackers.length`) with no `+` suffix. A `null` from any one project poisons the whole section total, so a partial page never sits under a header that counted the unfiltered set.

## Filters go into the query

`type` and `priority` are sent with `project.tracker.list`, so the fetched rows and the reported `total_count` describe the same set. Narrowing a loaded page in memory instead would put a header that counted the unfiltered set above rows that survived the filter.

## Subtree counts are computed daemon-side

`TrackerSyncManager.withTrackerSubtreeStats` attaches `childCount`/`doneCount` to every tracker from the full snapshot. A client holding one page still renders real child progress, and the card offers delete-tree only when that count is present — a missing count means the subtree was never computed.

## Idle roots

`TrackerSyncManager` keeps a root watch alive for `TRACKER_ROOT_IDLE_TTL_MS` (5 s) after its last listener detaches. The app no longer subscribes, so without that grace window every isolated request would trigger a fresh `ait list --all --long`. The manager is a read cache; live sync is covered in [docs/ait-tracker-live-sync.md](ait-tracker-live-sync.md).

## Counts without an exact total

The Kanban ready and open lanes split by `readyIds`, which no status total can express, so they fall back to their loaded counts. Every other lane, every List section, and the toolbar pills use the server counts above.
