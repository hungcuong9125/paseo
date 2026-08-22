# Live AIT Tracker Sync

## Goal

Keep tracker data current when an agent or another process changes a project's AIT database outside Paseo.

AIT remains the source of truth. Paseo does not open `.ait/ait.db` directly and does not maintain a second durable issue database. The daemon watches the AIT directory only to know when it must run the authoritative `ait` CLI again.

None of this is wired up on the client yet. The Tracker screen does not subscribe, so an external `ait` change — another client, or `ait` run from a terminal — only reaches the screen on a manual refresh. `useAggregatedTrackers` and the `tracker` domain of `packages/app/src/data/push-router.ts` have no callers and are scheduled for deletion, so do not build on them. How the screen loads today is in [docs/refactors/tracker-lazy-counts.md](refactors/tracker-lazy-counts.md).

## Current path

The existing request path is:

```text
app projectId
  -> project.tracker.list.request
  -> ProjectRegistry.get(projectId)
  -> project.rootPath
  -> ait list --long [--all], cwd=project.rootPath
  -> project.tracker.list.response
  -> app query
```

The daemon already resolves the project root in `packages/server/src/server/session/tracker/tracker-session.ts` and runs the CLI in `packages/server/src/services/ait-cli-service.ts`. Keep this behavior for legacy clients.

A project-specific push cannot safely update a cache keyed by the whole project set, so live sync needs one query per `(serverId, projectId, all)`, aggregated in memory.

## Target architecture

```text
Tracker screen mounts
  -> one live subscription per project query
  -> TrackerSyncManager resolves projectId -> rootPath
  -> AitRootWatch owns one observation of <rootPath>/.ait
  -> SnapshotVariant owns one all=false or all=true CLI snapshot
  -> ait list runs once per variant and is shared by all listeners
  -> subscribe.response installs the initial full snapshot in the app

External ait create/update/close
  -> .ait filesystem event
  -> AitRootWatch debounce
  -> each active SnapshotVariant refreshes through single-flight
  -> full project.tracker.updated snapshot per subscription
  -> app replaces that project's cache entry
  -> aggregate query output changes
```

There are two server layers:

```text
AitRootWatch(rootPath)
  - one file-observer subscription for the project root's .ait directory
  - existence probe when .ait does not exist
  - watcher retry and degraded polling
  - one debounce for the root
  - owns SnapshotVariant instances

SnapshotVariant(rootPath, all)
  - one snapshot and fingerprint for all=false or all=true
  - one refresh promise and queued-refresh flag
  - epoch and generation ordering
  - listeners keyed by subscriptionId
```

Use `packages/server/src/server/file-observer` for filesystem observation. Do not create platform-specific watchers in Tracker code and do not reuse the WorkspaceGit observer: `.ait` is gitignored and WorkspaceGit may exclude it.

## Subscription lifecycle

### Subscribe

The app sends a subscription request when a live project query is enabled:

```ts
{
  type: "project.tracker.subscribe.request",
  requestId,
  projectId,
  subscriptionId,
  all,
}
```

The daemon resolves `projectId` through `ProjectRegistry`. It must never accept a raw filesystem path from the client.

The manager then:

1. Gets or creates `AitRootWatch(rootPath)`.
2. Gets or creates `SnapshotVariant(all)` under that root watch.
3. Registers the listener by `subscriptionId`.
4. Starts observation or an existence probe.
5. Starts the variant's initial `ait list` refresh before returning the response.
6. Returns the full snapshot, including errors when AIT is not initialized or unavailable.

The initial response is authoritative for this subscription and replaces any existing app cache entry. A subscription can be re-created after reconnect even when its query key is unchanged.

### Unsubscribe

The app sends:

```ts
{
  type: "project.tracker.unsubscribe.request",
  requestId,
  subscriptionId,
}
```

This request has no response. Document that exception beside the schema. The daemon removes the listener. When the last listener leaves a variant, dispose that variant. When the last variant leaves a root watch, await its file-observer unsubscribe, clear timers, then remove the root watch.

After the unsubscribe barrier resolves, no callback, refresh, timer, or native watcher owned by that subscription may remain.

### Update

Every listener receives a full replacement snapshot:

```ts
{
  type: "project.tracker.updated",
  payload: {
    subscriptionId,
    projectId,
    trackers,
    hiddenCount,
    epoch,
    generation,
    error,
    errorCode,
  },
}
```

Send one event per subscription so the app can route the event directly to the matching query. Do not broadcast updates to sessions that did not subscribe.

## Snapshot and ordering rules

`SnapshotVariant` stores only an in-memory display snapshot. It is never persisted and never becomes an authority.

- `epoch` is monotonically allocated by the manager for each newly instantiated variant during the daemon process lifetime.
- `generation` starts at 1 for a variant epoch and increases for each accepted replacement.
- The client accepts a subscribe response unconditionally as the new stream baseline.
- The client accepts an update only when `subscriptionId` matches the active query and either `epoch` is newer or the epoch matches and `generation` is newer.
- A full snapshot replaces `trackers`, `hiddenCount`, `error`, and `errorCode`; never merge rows from two generations.
- The same `(rootPath, all)` variant shares one epoch and generation across all listeners. Each listener receives its own `subscriptionId`.

The `all` flag is part of the variant key. A `--all` result cannot be converted into the default result without reimplementing AIT's hidden-count semantics.

## Refresh rules

All calls that read tracker lists must go through the manager's variant single-flight:

- subscription bootstrap;
- legacy `project.tracker.list.request`;
- live query refresh;
- successful server-side tracker mutation;
- watcher-triggered refresh;
- degraded polling.

At most one `ait list` runs concurrently per variant. If a refresh is requested while one is running, set `refreshQueued` and run one follow-up refresh after the current one settles.

Use the existing CLI contract:

```text
all=false: ait list --long
all=true:  ait list --long --all
cwd:       project.rootPath
```

After a refresh, fingerprint the complete payload including error fields. Do not emit an update when the fingerprint is unchanged.

### External filesystem changes

Watch the `.ait` directory as one unit. This covers `ait.db`, `ait.db-wal`, `ait.db-shm`, rollback journals, atomic replacements, and future AIT files without coupling Paseo to SQLite journal mode.

Use a trailing debounce matching the existing checkout-diff pattern, initially 150 ms. A max-wait of 1 second may prevent an endless write burst from starving refreshes. These values are implementation constants and must be covered by deterministic fake-timer tests.

### Paseo-originated mutations

After a successful server-side mutation, call `TrackerSyncManager.requestRefresh(rootPath)` for every active variant of that project. The manager coalesces this refresh with the filesystem event caused by the mutation.

The live app must not invalidate a replica query and expect that invalidation to run `ait list`. Legacy fetch queries may keep their existing invalidation behavior. The server manager is the one place that guarantees the fresh CLI read.

### Manual refresh

`query.refetch()` remains a real `project.tracker.list.request`. In live mode the daemon routes it through the manager and forces a fresh single-flight read; it must not be a cache-only invalidation.

## Errors and recovery

Errors use the existing `TrackerErrorCode` values and are part of the full snapshot.

| Condition                          | Server behavior                                                          | App behavior                                                |
| ---------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Project missing or archived        | Return `not_found`; do not create a watch                                | Render the existing project error state                     |
| `.ait` missing or uninitialized    | Keep the subscription and probe `.ait` every 5 seconds while subscribed  | Show `uninitialised` until a success snapshot arrives       |
| `ait` missing from PATH            | Keep the subscription and retry a list every 10 seconds while subscribed | Show `cli_missing`; replace with success after installation |
| CLI timeout or malformed output    | Keep the subscription, retain the watch, publish error snapshot          | Show actionable retry/error state                           |
| Watcher attach or callback failure | Enter degraded polling and retry watcher attachment every 10 seconds     | Continue receiving full snapshots                           |
| Daemon reconnect                   | Resubscribe; subscribe response resets the cache baseline                | Do not compare the new response to the old epoch            |
| `.ait` removed after being watched | Await teardown safely, keep existence probe active if subscribed         | Transition to the error snapshot                            |

Do not write a canary file into `.ait`. A silent watcher failure remains a known residual risk; keep manual refresh and legacy refetch repair. Do not add a heartbeat until measurements show it is required.

## Protocol compatibility

Advertise the live path as an optional `server_info.features.aitTrackerLive` flag, tagged with `COMPAT(aitTrackerLive)` and a removal condition/date.

The app chooses the live subscription path once from this capability. A daemon without the capability uses the existing request/response fetch path. Do not spread version checks through Tracker components.

New schemas must be pure Zod structural schemas and must be included in the generated inbound validation. New names follow the dotted namespace convention. The push event is a one-way update and should use the repository's documented convention for non-correlated update events.

Old clients never send `project.tracker.subscribe.request`, so the daemon must not send live update events to them. This structural gate prevents old clients from receiving unknown outbound union members.

## App data model

Unbuilt — this is what a live-sync client would need, not what the app does. Replace the aggregate fetch entry with per-project entries:

```text
["trackers", serverId, projectId, all]
```

Each entry carries route metadata with:

```ts
{
  domain: "tracker",
  enabled,
  serverId,
  projectId,
  all,
  subscriptionId,
}
```

The app must:

- install the subscribe response as the query data;
- route `project.tracker.updated` to the matching query;
- discard stale epoch/generation events;
- aggregate per-project data with `useMemo`;
- preserve the existing `loadState`, `projectErrors`, `refetch`, and `isRefetching` public behavior;
- keep project identity on every aggregated row for mutations;
- keep legacy daemons working through the existing fetch query path.

Do not modify the existing dirty Tracker screen/stat files unless a test proves the sync change requires it. The live-sync implementation owns data transport and cache routing, not unrelated Tracker presentation corrections.

## Server ownership and suggested modules

Keep `TrackerSession` as the WebSocket adapter and project resolver. Add the manager at the server service boundary, close it during daemon shutdown, and inject it into `TrackerSession`.

Suggested ownership:

```text
packages/server/src/server/tracker-sync-manager.ts
packages/server/src/server/tracker-sync-manager.test.ts
packages/protocol/src/tracker/rpc-schemas.ts
packages/protocol/src/messages.ts
packages/client/src/daemon-client.ts
packages/app/src/data/push-router.ts
packages/app/src/tracker/
```

Follow the existing checkout-diff manager for target state, listener cleanup, initial snapshots, and reconnect subscription repair. Do not copy its code mechanically; Tracker refreshes use `AitService` and project roots rather than checkout diff inputs.

## Required tests

### Server manager tests

Use a temporary real project directory and injectable file-observer/AIT adapters. Cover:

1. One initial `ait list` for one subscription.
2. Two listeners share one root watch and one variant refresh.
3. `all=false` and `all=true` share one root watch but execute the correct CLI arguments.
4. A burst of filesystem events produces one refresh.
5. A refresh requested during an in-flight refresh produces one queued follow-up.
6. An unchanged fingerprint produces no update event.
7. A mutation-triggered refresh and watcher event coalesce.
8. `.ait` creation after an uninitialized subscription transitions to success.
9. `cli_missing` recovers after the executable becomes available.
10. Watcher failure enters degraded polling and retries attachment.
11. Last unsubscribe awaits teardown and leaves no active timer/subscription.
12. A missing or archived project returns `not_found` without a watcher.

### Protocol/session tests

Cover subscribe response, unsubscribe cleanup, update fan-out, error snapshots, epoch/generation ordering, and legacy list requests sharing the manager single-flight.

### App tests

Cover per-project query keys, initial snapshot installation, update routing, stale update rejection, reconnect baseline reset, aggregation across projects, project-specific error states, and legacy-daemon fetch behavior.

Use real `ait` and temporary databases where the existing AIT service tests already do so. Use injectable adapters only for filesystem timing, watcher failure, and deterministic event delivery. Do not use timing sleeps; use fake timers or explicit test barriers.

## Acceptance checklist

- `projectId` is the only client identity input; raw paths never cross the protocol.
- External `ait` writes update the visible project without manual refresh when the live capability is enabled.
- One project change does not run `ait list` for unrelated projects.
- Multiple clients share one daemon CLI refresh.
- No watcher or CLI process remains after the final unsubscribe.
- SQLite journal mode and individual filename assumptions are absent from implementation.
- AIT CLI remains the only issue semantic reader.
- Old daemons and old apps retain the existing request/response behavior.
- All focused tests pass.
- `npm run typecheck`, `npm run lint`, and `npm run format:check` pass.
- Existing dirty files outside the implementation scope remain untouched.
