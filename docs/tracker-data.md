# Tracker data

Tracker uses the host's `ait` CLI as its authority. Paseo does not open the SQLite database directly or persist a second issue database.

## Host requirements

Install AIT with `list --limit/--offset --sort` and paginated `search` support. A paginated response must carry `total_count` and `has_more`. Missing metadata is an error; Paseo does not infer pagination from the number of rows returned.

The client requires `server_info.features.aitTrackerSort` before browsing. An unsupported host reports an update error instead of selecting another loading strategy.

## Project boundary

Resolve the AIT root using the CLI's project boundary: the Git repository toplevel, or the project directory outside Git. A subdirectory project therefore reads the repository's `.ait/ait.db`.

The descriptor's `aitInitialized` gates Tracker requests. Only uninitialised projects need a global existence watch: a stale false hides the feature, while a stale true reaches an RPC that reports the error. Changes publish through the current project-directory observation path.

## Page budget and counts

All-projects browsing merges server-sorted streams into one page budget per status section. Selecting one project uses that project's cursor. Each Show more press adds at most one page budget; buffered rows are consumed before another request. Reconnected projects retain other projects' pages and contribute rows through the same merge frontier.

Send type, priority, and status filters to the daemon. A total must describe the same filtered set as its rows.

The daemon's full snapshot supplies type/status counts and subtree progress. Sending that snapshot over the relay would make paging ineffective. Failed or offline projects are reported separately; they do not contribute an invented total.

## Refresh and observation

The screen uses manual refresh and its polling control. It does not subscribe to tracker snapshots. Filesystem observation refreshes the daemon's shared read cache; it is not a client live-sync promise.

The root's short idle grace window lets sequential page/count requests reuse a snapshot without rebuilding the full list for each request. Keep watcher ownership in `TrackerSyncManager` and `server/file-observer`.
