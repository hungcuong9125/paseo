# Tracker Kanban redesign

`packages/app/src/tracker/kanban-grouping.ts` (300 lines) and `packages/app/src/components/tracker/tracker-kanban-board.tsx` (920 lines) build a board that cannot be used. This document states why, what to build instead, and what stays unresolved.

Status: **implemented and live, five Kanban lanes** (Ready/Backlog, Open/Todo, In progress, Done, Cancelled), **List view grouped to match**. Two plan-review rounds returned accept-with-changes; every required change was applied before implementation. All five sequencing steps, the Type-filter follow-up (now shared across both views), the post-ship Ready lane, the Cancelled-lane split, and the List-view grouping (`paseo-PQNMc`) — several of them explicit Human overrides of this plan's original positions — are built, reviewed, and merged. The board is wired into `tracker-screen.tsx`; the dead hierarchy board (`kanban-grouping.ts`, the old `tracker-kanban-board.tsx`) and the old flat pagination (`tracker-pagination.ts`/`.tsx`) are both deleted. See "Implementation record" below. Deferred items (the blocked-by marker, per-project swimlanes, optimistic drag, real physical drag-and-drop) remain out of scope by explicit choice — see "Deferred" and "Open UNKNOWNs".

## The diagnosis: two problems, not one

### Problem 1 — the columns are the wrong axis

The current board is not a Kanban. `buildKanbanBoard` groups by **hierarchy**: one column per `epic`, plus a `Standalone` column, plus a per-`initiative` section wrapper (`kanban-grouping.ts:154-238`). Cards are the task leaves under each epic.

| Symptom                              | Cause                                                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Infinite horizontal scroll           | Column count = epic count. Unbounded by construction. `COLUMN_WIDTH = 264` inside a `horizontal` ScrollView (`tracker-kanban-board.tsx:44,139-183`). |
| Rows of "No tasks" cards             | An epic with no task children still gets a full column.                                                                                              |
| Three nested levels in multi-project | project section → initiative section → epic column → sub-column (`KanbanSubColumn`, `kanban-grouping.ts:16-21`).                                     |
| Drag-to-change-status is impossible  | Dropping a card in another column would mean "change parent", not "change status". The gesture has no status semantics to carry.                     |

### Problem 2 — the board receives pre-filtered data

`tracker-screen.tsx:133-141` filters task leaves by `statFilter` before passing the set to the board at `:693-700`. The default filter is not `all`. A status board fed that set renders three columns of which two are permanently empty.

The comment at `tracker-screen.tsx:132` — "Keep containers for the Kanban hierarchy; only task leaves are filtered" — shows this filtering exists **to serve the hierarchy board**. It is part of the old model, not neutral infrastructure. Changing the grouping alone does not fix the board.

## Where the hierarchy model came from

`web-ait` (`/Volumes/DataSSD/HomeWork/TEMPLATE/paseo-demonthorn/upstreams/web-ait`) builds the same hierarchy board — its columns are issue titles, not statuses. Paseo's board is a faithful port of it.

The sibling project solved it differently. `paseo-doctrine-downstream` (SHA `3a02367aef1da144b3b3f270ce510ab38f50ad18`) builds a **status board** in 30 lines (`packages/app/src/issues/issue-board-model.ts:21-30`):

```ts
export const ISSUE_BOARD_STATUSES = ["open", "in_progress", "blocked", "deferred", "closed"];

export function buildIssueBoard(issues, filter) {
  const statuses = filter === "all" ? ISSUE_BOARD_STATUSES : [filter];
  return statuses.map((status) => ({
    status,
    issues: issues.filter((issue) => issue.status === status).sort(compareIssues),
  }));
}
```

Take from it: columns declared as a constant so column count never depends on data; column header = badge + count (`packages/app/src/issues/issues-screen.tsx:405-408`); each column owns its own vertical ScrollView (`:409`); **a status filter projects the board to a single lane**, which is also the compact-layout answer.

Do not take from it: it still wraps columns in a `horizontal` ScrollView at fixed 286px (`:392-397`, `:1181-1189`), has no drag and drop, and is single-project only.

## Columns

Five columns. Three map directly from `TrackerStatus` (`packages/protocol/src/tracker/types.ts:10`); Ready is a derived split of `open`, added after initial ship per Human's explicit request while live-testing (see "Ready lane" below), and Cancelled is a real fifth lane holding `cancelled`-status items (see "Cancelled lane" below).

This doc uses the internal lane names (Ready, Open, Done, Cancelled — matching `TrackerBoardLaneKey` and code identifiers) throughout. The user-facing labels differ for two of them, by Human's later request: Ready displays as **Backlog**, Open displays as **Todo**. This is a display-string-only rename (`tracker.kanban.lane.*` i18n values) — no code identifier, testID, or this doc's own vocabulary changed to match, to avoid the internal/display split drifting into every reference throughout this document and the codebase.

| Column      | Membership                                 |
| ----------- | ------------------------------------------ |
| Ready       | `open` **and** unblocked (in `readyIds`)   |
| Open        | `open` **and** blocked (not in `readyIds`) |
| In progress | `in_progress`                              |
| Done        | `closed`                                   |
| Cancelled   | `cancelled`                                |

`isDone()` already collapses `closed` and `cancelled` (`kanban-grouping.ts:60-62`). Keep that. The Done lane holds only `closed` items now that `cancelled` has its own lane (see "Cancelled lane"). The board must never present cancelled as "completed successfully" — a cancelled item carries its own `<StatusBadge>` on the card (`tracker-kanban-card.tsx`), and now also sits in a dedicated Cancelled lane rather than being merged into Done. Both `closed` and `cancelled` carry their own badge, added after ship when it turned out `closed` had no marker at all — see "Cards".

### Cancelled lane

Originally this plan argued `cancelled` should merge into Done (the row above used to read `closed` + `cancelled`): a Cancelled column is empty in most projects and costs more than it explains. Human overrode that: `cancelled` is now its own fifth lane, split out of Done. The card still marks cancelled distinctly, but the lane itself is first-class — it has its own header, its own empty state, and its own transition matrix entries (`open`/`in_progress` → `cancelled` via the `cancel` transition; `cancelled` → `open` via `reopen`; no direct `cancelled` ⇄ `done` path, matching how `done` ⇄ `in_progress` is also null). Sort it by `updatedAt` descending like Done. Selecting the Done filter projects **both** Done and Cancelled (both terminal, both excluded from the priority filters), so the Done filter never hides cancelled items.

### Priority is not a column

`P0`–`P4` is orthogonal to status: an item is `open` **and** `P0` simultaneously, so a Priority column double-counts it. The existing `PRIORITY` toolbar chip stays a filter.

### Ready lane

Originally deferred (see the archived rationale in "Deferred" below) — the original plan called this a stat card, matching `web-ait`'s `summary-stat-ready` (`index.html:1986,2004`), not a lane. Human overrode that after live-testing, in explicit contradiction of the original plan and of `web-ait`'s own layout (verified again at implementation time: `web-ait` has no Ready or Cancelled lane anywhere in `index.html`).

Verified directly against a real `ait` binary before building: `ait ready` returns every issue with no unresolved blocker, spanning **both** `open` and `in_progress` status, and automatically excluding `closed`/`cancelled`. This plan scopes the Ready lane to `open` items only — `in_progress` never moves to Ready regardless of blocker state, since being in progress means work already started. Ready is not a peer `TrackerStatus`; it is a derived boolean over `open` items, computed from a new `readyIds: Set<string>` fetched via `project.tracker.ready` (protocol RPC added for this, gated on `server_info.features.aitTrackerReady` since older daemons cannot serve it — see "Implementation record").

This reclassifies "Open" within the Kanban board specifically: it now means "open and blocked", not every `open` item. The List view is unaffected — its own `statFilter === "open"` still means `tracker.status === "open"`, full stop. The Kanban toolbar's Open filter chip projects **both** Ready and Open lanes together (they are the same underlying status, split only visually), so selecting "Open" never hides unblocked items. `p0`–`p4` filters also include Ready. `buildTrackerBoard` degrades to "everything open-status stays in Open, nothing is Ready" when `readyIds` is empty (loading, or the server predates the capability) — it never crashes and never shows a stuck-looking permanently-empty Ready column as the reason something is missing.

The move-menu's transition matrix (`tracker-transitions.ts`) is unaffected by Ready: `TrackerLane` there is `"open" | "in_progress" | "done" | "cancelled"`, since Ready is never itself a status to transition into (the UI layer maps `ready` → `open` before consulting the matrix, `tracker-kanban-column.tsx`). Cancelled **is** a real `TrackerLane` and carries its own matrix entries: `open`/`in_progress` → `cancelled` (the `cancel` transition), `cancelled` → `open` (the `reopen` transition also used by `done` → `open`), and no `cancelled` ⇄ `done` pair.

## Toolbar contract

This is the decision Problem 2 forces. `statFilter` means different things per view mode:

| View   | `statFilter` role                                                         |
| ------ | ------------------------------------------------------------------------- |
| List   | Filters the dataset. Unchanged from today.                                |
| Kanban | **Projects the board to a subset of lanes.** Does not filter the dataset. |

The filter domain is not just statuses. `TrackerStatFilter` is `open | in_progress | p0 | p1 | p2 | p3 | p4 | done | all`, and `matchesTrackerStatFilter` gives `p0`–`p4` the meaning "active (`open` or `in_progress`) **and** that priority" (`packages/app/src/tracker/tracker-stats.ts`). Every value needs defined Kanban behavior:

| `statFilter`  | Lanes shown                               | Cards within a lane       |
| ------------- | ----------------------------------------- | ------------------------- |
| `all`         | Ready, Open, In progress, Done, Cancelled | all                       |
| `open`        | Ready, Open                               | all                       |
| `in_progress` | In progress                               | all                       |
| `done`        | Done, Cancelled                           | all                       |
| `p0`–`p4`     | Ready, Open, In progress                  | filtered to that priority |

The priority rows reuse `matchesTrackerStatFilter` unchanged, so the control keeps exactly one predicate across both views — the Done lane (and Cancelled) is absent under a priority filter because the List view already excludes done items from `p0`–`p4`. Disabling the priority chips in Kanban was rejected: a dead control is worse than a consistent one.

`statFilter = "all"` → five lanes; `statFilter = "open"` → two lanes (Ready + Open). This single-lane projection is `buildIssueBoard(issues, filter)`'s case and is also the compact layout mechanism. One mechanism, three callers.

**View switching keeps two independent filter states**, `listStatFilter` and `kanbanStatFilter`, rendered through the same toolbar control. List keeps today's `"open"` default (`tracker-screen.tsx:100`); Kanban defaults to `"all"`. Sharing one state would open the board on a single Open lane, which reads as a broken board. Two states, no promotion rule, no magic.

Consequences, all mandatory:

- The board receives the project-filtered but **not** status-filtered set. `tracker-screen.tsx:133-141` must branch on `viewMode`.
- `hiddenCount` becomes meaningless in Kanban mode (nothing is hidden by the server). Do not render it there.

`all: true` is **already** wired unconditionally for both views (`tracker-screen.tsx:118-122` — the filter row's counts need the full set). This plan does not change it and must not be read as introducing it.

### Which types appear on the board

Board default: **task leaves only**, preserving today's behavior at `tracker-screen.tsx:137`. `initiative` and `epic` carry their own status in `ait` and are legitimately manageable, so add a **Type** toolbar filter (`Tasks` / `Epics` / `Initiatives` / `All`) defaulting to `Tasks`. Mixing all three granularities in one Open lane by default is what makes the current board unreadable; making it reachable by choice is not.

## What survives from `kanban-grouping.ts`

The file is not only a column builder. Before deleting anything, split it:

| Behavior                                                                       | Fate                                                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Epic-per-column, sub-columns, initiative sections, `CompletedRail`, `allClear` | Delete. Only the hierarchy board consumes them.                                      |
| Parent/child index and `descendantStats` (`childCount`/`doneCount`, `:85-127`) | **Keep**, extracted as a small helper. The card's child-progress line depends on it. |
| Cycle and depth guards (`MAX_TREE_DEPTH`, ancestor sets)                       | Keep with the helper. They guard malformed `parentId` data from `ait`.               |
| `compareTrackers` (`:66-68`, priority then id, unexported)                     | **Keep and export.** It is the implicit card ordering; the board must name its sort. |

`kanban-grouping.test.ts` is **replaced**, not deleted: new tests cover status partition, cancelled mapping, and malformed/missing `parentId`. The old file is removed only after the replacement model and its tests are green. Its only non-test consumer is `tracker-kanban-board.tsx` (import `:35`, call `:93`), which also carries a duplicate local `isDone` at `:600` that dies with the file.

### Within-lane sort

| Lane              | Sort                                                         |
| ----------------- | ------------------------------------------------------------ |
| Open, In progress | `compareTrackers` — priority, then id. Unchanged from today. |
| Done              | `updatedAt` descending, newest first.                        |

The Done lane needs a recency sort or the 50-card reveal cap is meaningless: a priority-then-id slice of several hundred closed items shows an arbitrary subset, not the recent work. `TrackerSummary` has no `updatedAt` today — `ait list --long` returns `updated_at` (`ait-cli-service.ts:127`) and `toTrackerSummary` drops it at `:164-172`, exactly as it drops `claimed_by`. Both fields are recovered in the same protocol step (see "Sequencing"), because splitting them would re-open that step later.

## Cards

The current card shows a truncated title, `Open P0`, and `No tasks` — meaningless on a leaf task, which is most cards.

Card content, each line dropped when empty:

1. Meta row: `TrackerStatusIcon` (same status→icon mapping as the detail sheet's `○ tracker-id.n` header) + `id · priority`
2. Title, clamped to two lines
3. Child progress `3/7`, only when the item has children
4. `claimedBy` agent
5. Project chip (multi-project only), sized to its content — never stretched to the card's full width

Revised after live-testing (Human feedback, this round): the parent-epic-title line was removed from both the Kanban card and the List row — it rendered inconsistently (present only for items with a parent, absent for standalone ones) and read as noise, not signal. The per-lane `<StatusBadge>` for `closed`/`cancelled` (added in `f4a373877`) was also removed from the card: lane position already conveys status, and duplicating it as a text badge was redundant once the meta-row status icon shipped. The status icon carries that signal now, matching the detail sheet's own convention instead of inventing a second one.

### Data contract — no per-card fetch

Nothing on the card may trigger an `ait show`. Sources:

- `claimedBy` and `updatedAt`: **available and currently discarded.** `AitIssueLongSchema` already parses `claimed_by` (`ait-cli-service.ts:124`) and `updated_at` (`:127`); `toTrackerSummary` drops both (`:164-172`). Fix by adding two optional fields to `TrackerSummarySchema` and stopping the drop. Additive, protocol-compatible, zero extra `ait` spawns. `updatedAt` is what the Done lane sorts on.
- Child progress and parent title: computed client-side from the `parentId` graph already in the list response.
- `blockedBy`: **not available.** `ait list --long` returns no dependency data. Dropped from the first pass; it shares the Ready decision.

### Badge primitive

`<StatusBadge>` takes `label: string` and `variant?: "success" | "error" | "muted"` (`packages/app/src/components/ui/status-badge.tsx:5-12`). It does **not** take a `status` prop. Column headers and card badges pass a translated label plus a variant. Bespoke pills stay forbidden (`docs/design.md` §14).

## Layout

Three fixed columns fit a desktop width, so the horizontal ScrollView and its scroll buttons (`tracker-kanban-board.tsx:139-183`) are removed outright.

- **Desktop**: up to five equal-flex columns side by side (Ready, Open, In progress, Done, Cancelled — however many `statFilter` projects), each with one vertical ScrollView and a sticky header.
- **Compact**: a segmented control over whichever lanes are projected selects one at a time, rendered full width. This is the `statFilter` projection above, not a second layout path.

One `useIsCompactFormFactor()` branch at the top of the board, per `docs/design.md` §9.

### Scroll ownership is preserved

`tracker-screen.tsx:685-688` deliberately keeps the board outside the outer vertical ScrollView because it needs a bounded-height parent (`flex: 1`). **That constraint is unchanged.** `kanbanContainer` stays `flex: 1`; the board is never nested in a vertical ScrollView; each column has exactly one vertical ScrollView. No vertical scroll region ever nests inside another — which is a second reason swimlanes are deferred.

### Large Done lane

The reference project shows 168 done items. The app ships no `FlashList`.

Decision: **incremental reveal**, not virtualization and not pagination. Each lane renders at most 50 cards with a "Show N more" footer. No new dependency, identical on every platform, and it keeps the lane a plain scroll region. Revisit only if a measurement shows 50 cards is already too slow.

The List view later adopted the identical pattern for the same reason (see "List view" below) — `tracker-pagination.ts`, the flat page-slicing utility the List view used before that, is deleted; nothing in the tracker feature uses page-based pagination anymore.

## Multi-project

Status columns, not one set per project. Cards carry a project chip and retain `serverId`/`projectId` so a mutation targets the right database.

Per-project swimlanes are deferred. With ~10 projects a default swimlane layout is 30 regions and reproduces the density problem being fixed.

## List view

Added after ship, per Human's explicit request (`paseo-PQNMc.2`): the List view groups into one section per real `TrackerStatus` — Todo (`open`), In progress, Done, Cancelled. The section label reads "Todo" now, not "Open" — renamed alongside the Kanban Open→Todo display rename so the two views use one vocabulary; the underlying `TrackerStatus` value and the `tracker-table-section-open` testID are unchanged, only the `tracker.list.section.open` i18n string moved to the same translated value as `tracker.kanban.lane.open` in every locale. Unlike Kanban it does **not** split Open into Ready/Open; that split is Kanban-derived `readyIds` data the List view never fetches, and List's own `statFilter === "open"` keeps its literal meaning (`tracker.status === "open"`, full stop — see "Toolbar contract" above).

List's own status filter chip row defaults to `"all"`, matching Kanban's existing `"all"` default — the original `"open"` default hid every other status behind an extra click for no documented reason, and diverged from Kanban's own default for no reason either.

Each section uses the same incremental-reveal pattern as the Kanban Done lane (50 rows, "Show more"), grouped over the **complete** filtered set, never a page slice — an early version grouped the paginated slice instead, which broke the entire premise (section membership and counts changed arbitrarily as the user paged, with items invisible on other pages and no indication they existed). Flat page-based pagination (`tracker-pagination.ts`/`.tsx`) is deleted; nothing in the tracker feature paginates anymore.

The Tasks/Epics/Initiatives/All type filter — originally Kanban-only (see "Sequencing") — is now one shared `typeFilter` state driving both views' tracker sets, always visible in the toolbar regardless of `viewMode`. Composes with `listStatFilter`: type narrows first, then the stat filter applies.

`getTrackerStatCounts` (`tracker-stats.ts`) used to hardcode `tracker.type === "task"` internally, so the toolbar's OPEN/IN PROGRESS/PRIORITY/DONE/ALL counts never moved when the Tasks/Epics/Initiatives filter changed — a real bug, caught by Human live-testing. Fixed by removing the internal filter and requiring the caller to pre-filter by type before counting; `tracker-screen.tsx` now feeds it the already-type-filtered `kanbanTrackers` set.

The OPEN/IN PROGRESS/PRIORITY/DONE/ALL chip row is styled to match the Tasks/Epics/Initiatives `SegmentedControl`: full pill border-radius, `theme.colors.surface2` on hover, solid `theme.colors.foreground` background with `theme.colors.surface0` text when active/selected — one visual language for every filter control in the toolbar instead of two.

## Status transitions

One transition matrix, shared by drag-and-drop and the compact action sheet. Neither surface may offer a transition the other lacks.

| From → To                      | Call                                       | Handler                      |
| ------------------------------ | ------------------------------------------ | ---------------------------- |
| Open → In progress             | `trackerUpdate({ status: "in_progress" })` | `tracker-session.ts:255-287` |
| In progress → Open             | `trackerUpdate({ status: "open" })`        | same                         |
| Open / In progress → Done      | `trackerClose({ trackerId })`              | `tracker-session.ts:290-323` |
| Done → Open                    | `trackerReopen({ trackerId })`             | `tracker-session.ts:325-354` |
| Open / In progress → Cancelled | `trackerCancel({ trackerId })`             | `tracker-session.ts`         |
| Cancelled → Open               | `trackerReopen({ trackerId })`             | `tracker-session.ts:325-354` |

`UpdateTrackerInput.status` is deliberately narrowed to `open | in_progress` (`types.ts:62`); close/reopen/cancel are dedicated RPCs. The mapping respects that. A drop never changes `parentId`; hierarchy is edited in the detail sheet.

`ait reopen --help` states: "Reopen a closed or cancelled issue (sets status back to open)." Cancelled → Open is therefore supported by the CLI contract, confirmed by an integration test running the real `ait` binary (`ait-cli-service.test.ts`).

**Cancel became a real drop target after ship** (`paseo-PQNMc.1`), reversing this plan's original position. The original reasoning — "it takes a reason, so it stays a kebab-menu action" — rested on a wrong assumption: `ait cancel --reason`/`--note` is **optional**, verified directly against `ait cancel --help` and the existing `trackerCancel` client method signature, not mandatory as first assumed. No reason-collection UI was built; dropping a card on Cancelled calls `trackerCancel` with no reason. `open`/`in_progress` → `cancelled` is real; `done` → `cancelled` and `cancelled` → `in_progress`/`done` all stay null — reopen first.

### Mutation state machine

**No optimistic move in the first pass.** The card enters a pending state in its original lane — disabled, reduced opacity (opacity only; colour changes for disabled state are forbidden, `docs/design.md` §14) — and moves only on a successful response.

| Event                                                                     | Behavior                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPC success                                                               | Card moves. The authoritative snapshot that follows replaces board state wholesale.                                                                                                                                                                                                            |
| RPC error (`tracker-session.ts:276-287`)                                  | Card stays, pending clears, error toast. No rollback animation is needed because nothing moved.                                                                                                                                                                                                |
| Snapshot arrives while a mutation is in flight                            | Snapshot wins and replaces board state. The pending flag is keyed by tracker id and survives replacement.                                                                                                                                                                                      |
| Stale drag — the item's status changed externally since the last snapshot | The RPC is sent as issued. `ait` is the authority on whether it succeeds. On success the following snapshot shows the real result, which may differ from what the user expected; on failure the error surfaces. The UI does not pre-validate against a snapshot it already knows may be stale. |

This ordering rule is why optimistic movement is deferred: with live sync landing separately, an optimistic card and an incoming snapshot would race, and the snapshot must always win.

### Platform split

The app ships both drag stacks — `@dnd-kit/core` + `@dnd-kit/sortable` for web (`packages/app/package.json:41-43`), `react-native-draggable-flatlist` for native (`:103`) — behind `draggable-list.web.tsx` / `draggable-list.native.tsx`.

That abstraction does not carry over: it reorders items _within one list_, while a Kanban needs a drop _across containers_. `@dnd-kit` supports multiple droppables natively; `react-native-draggable-flatlist` does not.

Drag capability and layout are **independent axes**. `useIsCompactFormFactor()` is a breakpoint, so a tablet at regular width renders the three-lane layout on native — where `@dnd-kit` is unavailable and `react-native-draggable-flatlist` cannot cross containers. Tying the fallback to "compact" would ship an iPad board with no way to move a card.

- **Web (any width)**: drag and drop via `DndContext` with one droppable per column, plus keyboard drag through `KeyboardSensor` (already used at `packages/app/src/components/draggable-list.web.tsx:6,158`).
- **Native (any width)**: no dragging. Long-press → "Move to…" action sheet, offering exactly the transition matrix above.
- **Every platform**: the action sheet is also the keyboard and screen-reader path, not a native-only affordance.

The two surfaces must agree on available transitions, pending/error behavior, labels, and screen-reader announcements. Put the transition matrix, its labels, and its announcement strings in **one shared module** consumed by both; if they diverge, it is two products.

## Acceptance criteria

Not optional extras. The current board has no `useTranslation` import and hardcodes `Standalone`, `General`, `No tasks`, `Completed`.

- **i18n**: translation keys for every label, empty state, status name, action-sheet entry, and error message. Follow `use-tracker-mutations.ts`.
- **Accessibility**: keyboard drag on web; announcements on drag start, lane change, drop success, and failure; the compact action sheet reachable by screen reader with the same options.
- **Test IDs**: `tracker-kanban-column-${status}` per the doctrine-downstream convention.
- **Unit tests**: status partition, cancelled → Done mapping, malformed/missing `parentId`, transition matrix.
- **Component tests**: empty lanes, multi-project chips, compact lane selection, project error states.
- **Web tests**: pointer drag, keyboard drag, failed drop.
- **Compact tests**: action sheet options and results.

## Sequencing

`packages/app/src/screens/tracker-screen.tsx`, `packages/app/src/tracker/tracker-stats.ts`, `packages/app/src/tracker/tracker-stats.test.ts`, and `packages/app/src/tracker/use-aggregated-trackers.ts` all have other active owners on `feat/ait-issues-menu-v040`.

1. Protocol: add optional `claimedBy` and `updatedAt` to `TrackerSummarySchema`, stop dropping them in `toTrackerSummary`. Regenerate the zod-aot inbound validation (`docs/protocol-validation.md`). Self-contained, no app changes.
2. Extract the parent/child helper and `compareTrackers` out of `kanban-grouping.ts` with their own tests. Old board still runs.
3. New status board model + card component + tests, unmounted.
4. Board component: three lanes, lane projection, incremental reveal, transitions.
5. **Last**, after the current owners hand back: the `tracker-screen.tsx` toolbar contract (`viewMode` branch at `:133-141`, the two filter states, `hiddenCount` suppression), then delete the dead hierarchy code.

Steps 1–4 touch no owned file. Two dependencies to sequence around:

- Step 3's projection input needs `TrackerStatFilter`, which today lives only in the other owner's uncommitted `tracker-stats.ts`. Either wait for that to land or define the projection's input type independently and adapt at step 5.
- Before step 4, spike `DndContext` across per-column vertical ScrollViews on RN-web. The repo proves `@dnd-kit` works on RN-web for single-list reorder, but cross-container drop with drag auto-scroll is unproven here. See UNKNOWN 3.

## Deferred

- **The blocked marker on Open cards.** `ait list --long` returns no per-item blocker detail (only membership in `readyIds`, which is enough to place the card, not enough to show _why_ it's blocked or _by what_). A card in the Open lane is knowably blocked by construction; showing which tracker blocks it would need `ait dep tree` or similar, a separate RPC not built here.
- **Per-project swimlanes.** The project chip is sufficient for the first pass.
- **Optimistic drag.** Revisit once live tracker sync is stable.

Resolved after initial ship, overriding the original plan: **Ready filter.** Originally scoped as a deferred stat-only control (see "Ready lane" above for the full account) — built as a real lane after Human requested it live-testing the shipped board, via a new `project.tracker.ready` RPC (`packages/protocol/src/tracker/rpc-schemas.ts`, `AitService.listReadyIds`, gated on `server_info.features.aitTrackerReady`).

**Real physical drag-and-drop (mouse/touch drag) is deferred by Human's own explicit choice**, reconfirmed during the `paseo-PQNMc` round — not a technical gap being papered over. Human explicitly asked to leave it out this round rather than spend the time on the still-unresolved `@dnd-kit` cross-container spike (UNKNOWN below). The kebab/long-press "Move to…" surface is the sole interaction for every transition, including the new `cancel` one, on every platform.

## Open UNKNOWNs

1. **Cost of `ait list --long --all`.** The tracker screen already fetches every status unconditionally for both views (`tracker-screen.tsx:118-122`), so this is a measurement of the status quo, not a cost this plan adds. The 50-card reveal cap bounds _rendering_ only, never transport. 168 done items in the reference project; unknown at real scale. Carried over from the live-sync work, still unmeasured there.
2. **`@dnd-kit` cross-container drop on RN-web — spike not attempted, tooling-blocked, not resolved.** The step-4 implementation had no browser-automation tool available to drive a real drag gesture, and standing up a full Playwright harness for a throwaway proof was disproportionate to the time-box. This shipped the plan's own contingency instead of guessing: `tracker-kanban-move-menu.tsx` is a shared "Move to…" surface (kebab dropdown on every platform, plus native long-press) reading the same `getTrackerTransition` matrix, live on web and native today. Real drag-and-drop remains unbuilt and unspiked — single-list reorder is still the only proven `@dnd-kit`-on-RN-web data point in this codebase (`draggable-list.web.tsx`). A real spike with browser tooling is a distinct follow-up, not a blocker: the board is fully usable without it.

Resolved during implementation: **Type filter default** — built exactly as proposed. `kanbanTypeFilter` defaults to `"task"`, with a `SegmentedControl` (Tasks/Epics/Initiatives/All) visible only in Kanban mode, filtering at the screen level before `buildTrackerBoard` so that module's status-only partitioning contract stays untouched.

## Implementation record

**Status: fully implemented and wired — five Kanban lanes, grouped List view, shared type filter.** All five sequencing steps, the type-filter follow-up, the Ready lane, the Cancelled lane, and the List-view grouping are merged. 22 commits on `feat/ait-issues-menu-v040`:

- `41db50ba6` — protocol: `claimedBy`/`updatedAt` on `TrackerSummary`.
- `a45ff5f7a`, `d518d2ee9` — status board model (`buildTrackerBoard`) + Kanban card, i18n across 9 locales.
- `6e8fd53b6` — board component: three lanes, incremental reveal, shared "Move to…" action sheet.
- `696591e6d` — `tracker-hierarchy.ts` extraction (parent/child index, `compareTrackers` exported).
- `742fd82a3` — `tracker-transitions.ts` (`getTrackerTransition`, `createPendingTrackerSet`).
- `c802c5a05` — step 5: wired into `tracker-screen.tsx`, two-filter-state toolbar contract, card tap opens the detail sheet, dead hierarchy board (`kanban-grouping.ts`, old `tracker-kanban-board.tsx`) deleted.
- `509981153` — fix: native card tap routed through `ContextMenuTrigger`'s own `onPress` instead of a nested `Pressable`, avoiding an RN touch-responder conflict with the long-press move menu.
- `239c3ce11` — fix: the daemon-unavailable error path now goes through `t()` instead of a hardcoded string, closing an i18n-guard-test failure.
- `a0c963e0b` — base dependency: `TrackerStatFilter`/`matchesTrackerStatFilter` generalized to per-level p0–p4 and wired to real filtering (Human-confirmed non-mockup behavior).
- `2f628064a` — cleanup: `tracker-board-model.ts` reconciled to import the real `TrackerStatFilter`/`compareTrackers` instead of carrying duplicate local copies, once both landed.
- `836943582` — Kanban Type filter (Tasks/Epics/Initiatives/All), closing the "Which types appear on the board" gap found in Lead re-review after step 5 landed.
- `716a4b006` — fix: horizontal padding restored on the Kanban board (columns sat flush against the screen edge; the toolbar above them was correctly padded, the board wasn't).
- `f4a373877` — fix: `closed` items get their own `<StatusBadge>`, symmetric to `cancelled` — previously only `cancelled` had a marker, so a closed item in the Done lane looked identical to an unlabeled one.
- `f74afe227` — new `project.tracker.ready` RPC end-to-end (protocol + server), gated on `server_info.features.aitTrackerReady`.
- `2ab9db101` — Ready lane wired into the board: `buildTrackerBoard` gains a `readyIds` parameter and a 4th lane, capability-gated fan-out fetch across projects, Open toolbar filter now projects Ready+Open together, transition-lane mapping (`ready` → `open`) at the UI layer.
- `2eb5f52c5` — `paseo-PQNMc.1`: Ready/Open lane display text renamed to Backlog/Todo (i18n string values only, internal identifiers unchanged); Cancelled split into its own 5th lane with a real `cancel` transition (`open`/`in_progress` → `cancelled`, `cancelled` → `open` via reopen — no reason-collection UI needed, `ait cancel --reason` is optional, correcting an earlier wrong assumption); Done-lane incremental-reveal cap extended to Cancelled.
- `08c330694` — `paseo-PQNMc.2`: List view grouped into one section per real `TrackerStatus`, matching Kanban's incremental-reveal pattern instead of flat pagination; the Tasks/Epics/Initiatives/All type filter unified into one shared state driving both views; `tracker-pagination.ts`/`.tsx` and their tests deleted as fully dead code.
- `03393cd57` — live-testing touch-up round: card status moved from a text badge to a `TrackerStatusIcon` on the meta row (matching the detail sheet's `○ id` convention); the project chip no longer stretches full-width; the parent-title line removed from both the Kanban card and the List row; List's status filter now defaults to `all`; the List "Open" section relabeled "Todo"; toolbar counts fixed to recount against the selected type filter (previously hardcoded to `task`); OPEN/IN PROGRESS/PRIORITY/DONE/ALL chips restyled to match the Tasks/Epics/Initiatives `SegmentedControl`.

Every commit reviewed against this document and independently re-verified (typecheck across all 10 workspaces, lint, tests re-run outside the implementing agent's own report) before acceptance. Several rounds caught real defects the implementing agent's own verification missed: the native gesture conflict (`509981153`) and the untranslated error string (`239c3ce11`) in the original pass; in the `paseo-PQNMc` round, a missing reveal-cap extension and two stale tests in `2eb5f52c5`, and — most significantly — a pagination-before-grouping architecture defect in `08c330694`'s first candidate (status sections were computed from the paginated page slice, not the full filtered set, so section membership and counts changed arbitrarily as the user paged) that required a full correction round before acceptance, plus one further post-acceptance fix (`tracker.list.showMore` hardcoded English in 8 non-English locales, caught by Lead after the candidate had already passed its own verification).

The Ready lane (`f74afe227`, `2ab9db101`) and the Cancelled lane (`2eb5f52c5`) were **not** in the originally accepted plan — this document explicitly argued against both, matching `web-ait`'s own layout. Human overrode both after live-testing the shipped board and asked for them directly; see "Ready lane" and "List view" above for the full accounts and the technical verification (real `ait` binary, isolated temp project) that shaped each design before building. Real physical drag-and-drop was reconsidered in the same round and stayed deferred, this time by Human's own explicit choice rather than the earlier tooling constraint — see "Deferred".
