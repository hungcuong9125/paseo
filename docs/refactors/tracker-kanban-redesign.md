# Tracker Kanban redesign

`packages/app/src/tracker/kanban-grouping.ts` (300 lines) and `packages/app/src/components/tracker/tracker-kanban-board.tsx` (920 lines) build a board that cannot be used. This document states why, what to build instead, and what stays unresolved.

Status: **implemented and live, five lanes** (Backlog, Todo, In progress, Done, Cancelled). Two plan-review rounds returned accept-with-changes; every required change was applied before implementation. All five sequencing steps, the Type-filter follow-up, the post-ship Ready lane (added at Human's explicit request after live-testing, overriding this plan's original "Ready is not a column" position), and the later Cancelled-lane split (paseo-PQNMc.1) are built, reviewed, and merged — the board is wired into `tracker-screen.tsx`, and the dead hierarchy board (`kanban-grouping.ts`, the old `tracker-kanban-board.tsx`) is deleted. See "Implementation record" below. Deferred items (the blocked-by marker, per-project swimlanes, optimistic drag, a real-browser DnD spike) remain out of scope by design — see "Deferred" and "Open UNKNOWNs".

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

1. Tracker id + priority + project chip (multi-project only)
2. Title, clamped to two lines
3. Parent epic title — the hierarchy signal a status board would otherwise lose
4. Child progress `3/7`, only when the item has children
5. `claimedBy` agent

Cancelled items in the Done lane carry a distinct marker, not the success treatment used for `closed`.

### Data contract — no per-card fetch

Nothing on the card may trigger an `ait show`. Sources:

- `claimedBy` and `updatedAt`: **available and currently discarded.** `AitIssueLongSchema` already parses `claimed_by` (`ait-cli-service.ts:124`) and `updated_at` (`:127`); `toTrackerSummary` drops both (`:164-172`). Fix by adding two optional fields to `TrackerSummarySchema` and stopping the drop. Additive, protocol-compatible, zero extra `ait` spawns. `updatedAt` is what the Done lane sorts on.
- Child progress and parent title: computed client-side from the `parentId` graph already in the list response.
- `blockedBy`: **not available.** `ait list --long` returns no dependency data. Dropped from the first pass; it shares the Ready decision.

### Badge primitive

`<StatusBadge>` takes `label: string` and `variant?: "success" | "error" | "muted"` (`packages/app/src/components/ui/status-badge.tsx:5-12`). It does **not** take a `status` prop. Column headers and card badges pass a translated label plus a variant. Bespoke pills stay forbidden (`docs/design.md` §14).

## Layout

Three fixed columns fit a desktop width, so the horizontal ScrollView and its scroll buttons (`tracker-kanban-board.tsx:139-183`) are removed outright.

- **Desktop**: three equal-flex columns side by side, each with one vertical ScrollView and a sticky header.
- **Compact**: a segmented control (`Open | In progress | Done`) selects one lane, rendered full width. This is the `statFilter` projection above, not a second layout path.

One `useIsCompactFormFactor()` branch at the top of the board, per `docs/design.md` §9.

### Scroll ownership is preserved

`tracker-screen.tsx:685-688` deliberately keeps the board outside the outer vertical ScrollView because it needs a bounded-height parent (`flex: 1`). **That constraint is unchanged.** `kanbanContainer` stays `flex: 1`; the board is never nested in a vertical ScrollView; each column has exactly one vertical ScrollView. No vertical scroll region ever nests inside another — which is a second reason swimlanes are deferred.

### Large Done lane

The reference project shows 168 done items. `tracker-pagination.ts` is page slicing for the list view, not virtualization, and the app ships no `FlashList`.

Decision: **incremental reveal**, not virtualization and not pagination. Each lane renders at most 50 cards with a "Show N more" footer. No new dependency, identical on every platform, and it keeps the lane a plain scroll region. Revisit only if a measurement shows 50 cards is already too slow.

## Multi-project

Three status columns, not three per project. Cards carry a project chip and retain `serverId`/`projectId` so a mutation targets the right database.

Per-project swimlanes are deferred. With ~10 projects a default swimlane layout is 30 regions and reproduces the density problem being fixed.

## Status transitions

One transition matrix, shared by drag-and-drop and the compact action sheet. Neither surface may offer a transition the other lacks.

| From → To                 | Call                                       | Handler                      |
| ------------------------- | ------------------------------------------ | ---------------------------- |
| Open → In progress        | `trackerUpdate({ status: "in_progress" })` | `tracker-session.ts:255-287` |
| In progress → Open        | `trackerUpdate({ status: "open" })`        | same                         |
| Open / In progress → Done | `trackerClose({ trackerId })`              | `tracker-session.ts:290-323` |
| Done → Open               | `trackerReopen({ trackerId })`             | `tracker-session.ts:325-354` |

`UpdateTrackerInput.status` is deliberately narrowed to `open | in_progress` (`types.ts:62`); close/reopen/cancel are dedicated RPCs. The mapping respects that. **Cancel is not a drop target** — it takes a reason, so it stays a kebab-menu action. A drop never changes `parentId`; hierarchy is edited in the detail sheet.

`ait reopen --help` states: "Reopen a closed or cancelled issue (sets status back to open)." Cancelled → Open is therefore supported by the CLI contract. Paseo shells out, so the semantics belong to `ait`, and `ait-cli-service.test.ts:62-93` covering only `closed → open` is **missing coverage, not a missing capability**. Add the cancelled case to that test as part of this work.

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

## Open UNKNOWNs

1. **Cost of `ait list --long --all`.** The tracker screen already fetches every status unconditionally for both views (`tracker-screen.tsx:118-122`), so this is a measurement of the status quo, not a cost this plan adds. The 50-card reveal cap bounds _rendering_ only, never transport. 168 done items in the reference project; unknown at real scale. Carried over from the live-sync work, still unmeasured there.
2. **`@dnd-kit` cross-container drop on RN-web — spike not attempted, tooling-blocked, not resolved.** The step-4 implementation had no browser-automation tool available to drive a real drag gesture, and standing up a full Playwright harness for a throwaway proof was disproportionate to the time-box. This shipped the plan's own contingency instead of guessing: `tracker-kanban-move-menu.tsx` is a shared "Move to…" surface (kebab dropdown on every platform, plus native long-press) reading the same `getTrackerTransition` matrix, live on web and native today. Real drag-and-drop remains unbuilt and unspiked — single-list reorder is still the only proven `@dnd-kit`-on-RN-web data point in this codebase (`draggable-list.web.tsx`). A real spike with browser tooling is a distinct follow-up, not a blocker: the board is fully usable without it.

Resolved during implementation: **Type filter default** — built exactly as proposed. `kanbanTypeFilter` defaults to `"task"`, with a `SegmentedControl` (Tasks/Epics/Initiatives/All) visible only in Kanban mode, filtering at the screen level before `buildTrackerBoard` so that module's status-only partitioning contract stays untouched.

## Implementation record

**Status: fully implemented and wired, including the post-ship Ready lane.** All five sequencing steps, the type-filter follow-up, and the Ready lane are merged. 20 commits on `feat/ait-issues-menu-v040`:

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

Every commit reviewed against this document and independently re-verified (typecheck across all 10 workspaces, lint, tests re-run outside the implementing agent's own report) before acceptance — including two correctness issues caught only by that independent re-verification: the native gesture conflict (`509981153`) and the untranslated string (`239c3ce11`), neither of which the implementing agent's own test run had caught.

The Ready lane (`f74afe227`, `2ab9db101`) was **not** in the originally accepted plan — the plan explicitly argued against it, matching `web-ait`'s own layout. Human overrode that after live-testing the shipped 3-lane board and asked for it directly; see "Ready lane" above for the full account and the technical verification (real `ait` binary, isolated temp project) that shaped the design before building.

Remaining: step 5 (toolbar contract, wiring, dead-code deletion) — see "Sequencing".
