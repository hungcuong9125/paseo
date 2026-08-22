# Tracker lazy counts + server-side pagination

Frozen contract for the batch that replaces the Tracker screen's
fetch-everything background sweep with explicit pagination plus exact
server-computed counts. Every seat in this batch implements against the
shapes below verbatim — do not redesign them, do not rename fields.

## The problem being fixed

`useTrackerProjectData` pages `project.tracker.list` in a background loop
until every `(project, status)` pair is exhausted
(`packages/app/src/tracker/use-tracker-project-data.ts` `sweepOne`), so the
client downloads every project's whole `.ait/ait.db` over the WebSocket. All
counts are derived from that growing array
(`tracker-table.tsx` section header, `tracker-kanban-column.tsx` lane badge,
`getTrackerStatCounts` toolbar pills), which is why they converge instead of
being right, and why the lane badge carries a `+` suffix while `isComplete`
is false. "Show N more" is a client-side reveal over already-loaded rows, not
a fetch.

Reading the database costs ~13 ms per `ait` invocation on the daemon host.
Shipping every row to a phone over the relay is the expensive part. So the
daemon reads locally and sends aggregates plus the visible page.

`ait list --limit N` already returns `total_count` scoped to the applied
filters; `ait-cli-service.ts` parses it and throws it away.

## Locked decisions

- No persisted counts file. `TrackerSyncManager` already holds a full
  in-memory snapshot per `.ait` root with a file-observer watch and debounce;
  stats derive from that snapshot, so they invalidate for free when another
  agent writes the database.
- `isComplete` and the `+` suffix are deleted everywhere. There is no
  "converging count" state left in the UI.
- The background sweep is deleted unconditionally, on every daemon version.
- When `server_info.features.aitTrackerStats` is false, every total in the
  contract below is `null` and the UI renders the loaded-so-far count with no
  suffix. Pagination still works — it is driven by `hasMore`, not by totals.
- Live sync is out of scope for this batch and tracked separately.
  `TrackerSyncManager` stays; the orphaned client-side subscribe path is not
  revived here.

## Wire contract

`packages/protocol/src/tracker/rpc-schemas.ts`. Additive and optional, per
docs/protocol-compatibility.md. New RPC names follow docs/rpc-namespacing.md.

### 1. `TrackerPageInfoSchema` gains a total

```ts
export const TrackerPageInfoSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  // Rows matching the request's filters, from `ait list --limit`'s
  // `total_count`. Absent when the CLI binary predates pagination.
  totalCount: z.number().int().nonnegative().optional(),
});
```

### 2. `ProjectTrackerListRequestSchema` gains a priority filter

```ts
priority: TrackerPrioritySchema.optional(),
```

Threads through `ListTrackersOptions` in `ait-cli-service.ts` to
`ait list --priority <P0-P4>`.

### 3. `TrackerSummarySchema` gains subtree stats

```ts
// Entire subtree under this tracker (direct children plus all descendants),
// matching buildTrackerHierarchy().descendantStats. Computed by the daemon
// from the full snapshot so a client holding one page still renders real
// child progress. Absent on a daemon that predates the feature.
childCount: z.number().int().nonnegative().optional(),
doneCount: z.number().int().nonnegative().optional(),
```

`doneCount` counts `closed` and `cancelled`, same as `tracker-hierarchy.ts`
`isDone`.

### 4. New `project.tracker.stats` RPC

Explicit object shapes, not `z.record` — the zod-aot inbound validator
generator (docs/protocol-validation.md) must be able to compile them.

```ts
const TrackerStatusCountsSchema = z.object({
  open: z.number().int().nonnegative(),
  in_progress: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
});

const TrackerPriorityCountsSchema = z.object({
  P0: z.number().int().nonnegative(),
  P1: z.number().int().nonnegative(),
  P2: z.number().int().nonnegative(),
  P3: z.number().int().nonnegative(),
  P4: z.number().int().nonnegative(),
});

// One bucket per type granularity the toolbar's type filter offers.
const TrackerStatsBucketSchema = z.object({
  total: z.number().int().nonnegative(),
  byStatus: TrackerStatusCountsSchema,
  byPriority: TrackerPriorityCountsSchema,
});

export const TrackerStatsCountsSchema = z.object({
  all: TrackerStatsBucketSchema,
  task: TrackerStatsBucketSchema,
  epic: TrackerStatsBucketSchema,
  initiative: TrackerStatsBucketSchema,
});

export const ProjectTrackerStatsRequestSchema = z.object({
  type: z.literal("project.tracker.stats.request"),
  requestId: z.string(),
  projectId: z.string(),
});

export const ProjectTrackerStatsResponseSchema = z.object({
  type: z.literal("project.tracker.stats.response"),
  payload: z.object({
    requestId: z.string(),
    projectId: z.string(),
    counts: TrackerStatsCountsSchema.nullable(),
    error: z.string().nullable(),
    errorCode: TrackerErrorCodeSchema.nullable(),
  }),
});
```

Counts span every status — `closed` and `cancelled` included — matching what
`getTrackerStatCounts` counts today. Priority counts span every status too,
for the reason already documented in `tracker-stats.ts`.

### 4b. The snapshot has to actually be cached

`TrackerSyncManager.getSnapshot` tears the root watch down again whenever
`listenerCount === 0`. Nothing subscribes any more — that is the point of this
batch — so every paginated list request and every stats request pays a fresh
`ait list --all --long` plus a watcher create/destroy cycle. One screen load
across five projects is twenty full database reads.

Keep the root alive on a short TTL after the last listener drops, so the reads
in one screen load share a snapshot and the file observer still invalidates it.
The "counts are free" claim this whole design rests on is only true against a
warm root.

### 5. Feature flag

`server_info.features.aitTrackerStats: boolean`. Gated once, at the app's
stats hook. Everything else reads `null` totals and degrades to loaded-so-far
counts.

### 6. Client

`packages/client/src/daemon-client.ts`:

```ts
trackerStats(input: { projectId: string }): Promise<{
  counts: TrackerStatsCounts | null;
  error: string | null;
  errorCode: TrackerErrorCode | null;
}>;
```

`trackerList` accepts the new `priority` field and surfaces
`pageInfo.totalCount`.

## App hook contract

`packages/app/src/tracker/use-tracker-project-data.ts` — `isComplete` is
removed, the sweep is removed, and the hook returns:

```ts
{
  /** Only the pages actually loaded. */
  trackers: AggregatedTracker[];
  /** Summed `pageInfo.totalCount` across the in-scope projects, per status.
   * `null` when any in-scope project did not report one. */
  sectionTotals: Record<TrackerStatus, number | null>;
  sectionHasMore: Record<TrackerStatus, boolean>;
  sectionLoadingMore: Record<TrackerStatus, boolean>;
  /** Fetches exactly one more page per in-scope project for that status. */
  loadMore: (status: TrackerStatus) => void;
  isLoading: boolean;
  projectErrors: TrackerProjectError[];
  patchTracker: (updated: AggregatedTracker) => void;
  removeTrackers: (ids: string[]) => void;
  refetch: () => void;
}
```

`loadMore` must clear `sectionLoadingMore[status]` before it bails on a stale
scope, and `loadFirstPages` must reset the whole record — otherwise switching
project mid-fetch strands a spinner on the new scope's "Show more".

`patchTracker` and `removeTrackers` adjust `sectionTotals` themselves:
decrement the status a tracker left, increment the one it landed in, decrement
on removal, and leave a `null` total alone. Counts came from `items.length`
before this batch, so they self-corrected; now that a total is authoritative,
closing an item has to move the number or the header lies until the next
refetch.

The hook takes the type and priority filters and passes them to
`fetchTrackerPage`, and `scopeKey` includes them:

```ts
type?: TrackerType;       // both views
priority?: TrackerPriority;  // List only — Kanban projects lanes, it does not filter the set
```

Filtering a loaded page in memory was fine when the sweep guaranteed the page
was everything. It is not fine now: page one of fifty rows narrowed to Tasks
renders three rows under a header claiming two hundred. Both the rows and
`totalCount` have to be scoped by the same query.

New `packages/app/src/tracker/use-tracker-stats.ts`:

```ts
useTrackerStats(options: {
  projects: readonly TrackerProjectInput[];
  selectedProjectId: string | null;
  enabled: boolean;
}): {
  /** Summed across in-scope projects. `null` when the host lacks
   * `aitTrackerStats`, or while loading. */
  counts: TrackerStatsCounts | null;
  isLoading: boolean;
  refetch: () => void;
};
```

## Component contract

`packages/app/src/components/tracker/`. `isComplete` is removed from every
prop list and every render path.

`TrackerTable` (sectioned variant) gains:

```ts
sectionTotals: Partial<Record<TrackerStatus, number | null>>;
sectionHasMore: Partial<Record<TrackerStatus, boolean>>;
sectionLoadingMore: Partial<Record<TrackerStatus, boolean>>;
onLoadMore: (status: TrackerStatus) => void;
```

- Section header count renders `sectionTotals[status] ?? items.length`.
- "Show N more" renders when `sectionHasMore[status]`, calls
  `onLoadMore(status)`, and shows the spinner while
  `sectionLoadingMore[status]`. The client-side `revealCounts` state and
  `REVEALED_STATUSES` go away.
- The `flat` variant (search results) keeps `hasMoreAll`/`onLoadMoreAll`
  unchanged.
- `useTrackerPageStep`, `REVEAL_STEP_DESKTOP`, and `REVEAL_STEP_COMPACT` keep
  their current names and signatures — other modules import them.
- Row `hasChildren` comes from `tracker.childCount`, falling back to the
  passed `hierarchy` when it is undefined.
- The four props above are required on the sections variant and absent from
  the flat variant. Model that as a discriminated union on `variant` rather
  than four optional props — optional pagination wiring lets a caller drop
  `onLoadMore` and get a table whose "Show more" silently never appears.
- The "Show N more" label counts what is actually left:
  `Math.min(revealStep, total - loaded)` when the total is known, `revealStep`
  when it is not.

`TrackerKanbanColumn` / `TrackerKanbanBoard` gain, per lane:

```ts
laneTotal: number | null;
laneHasMore: boolean;
laneLoadingMore: boolean;
onLoadMore: () => void;
```

Lane badge renders `laneTotal ?? cards.length`, with no `+` suffix. The Done
lane's total is `closed + cancelled` — the screen does that summing, the
column just renders what it is handed. Same required-not-optional rule as the
table, and the same `Math.min(revealStep, total - loaded)` label.

Card child progress reads `tracker.childCount` / `tracker.doneCount` and only
falls back to `hierarchy.descendantStats` when they are undefined. Without
this the Kanban board regresses: the sweep used to make the local hierarchy
complete, and nothing does after this batch.

Delete-tree in the card menu is offered only when `tracker.childCount` is
defined — `deleteDisabled={tracker.childCount === undefined}`. It used to be
gated on `isComplete` for the same reason: cascading a delete over a subtree
you have undercounted is the one destructive action here.

`TrackerKanbanCard` drops `isComplete` and renders `childCount`/`doneCount`
with no suffix.

## Screen integration

`packages/app/src/screens/tracker-screen.tsx` wires the two hooks to the
components, maps status totals onto Kanban lanes, and feeds the toolbar stat
pills from `useTrackerStats` instead of `getTrackerStatCounts` over the
loaded array.

The `bellProjectData` sweep at `pageSize: 1` is deleted. It exists only to
surface per-project `ait init` errors for the whole workspace, so
`useTrackerStats` carries a `projectErrors` list alongside its counts — it
already fans out one request per project, and a project that needs `ait init`
fails exactly there.

On a host too old to advertise `aitTrackerStats` the bell goes quiet. That is
the capability gate doing its job (docs/protocol-compatibility.md: gate once,
no fallback paths), not a regression to work around — that host cannot serve
any of this feature set.
