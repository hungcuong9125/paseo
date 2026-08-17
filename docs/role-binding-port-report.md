# Role binding port — implementation record (2026-08-17)

Point-in-time record of porting the native role-binding feature from `paseo-doctrine-downstream` (v0.4.0-paseo.5) onto upstream Paseo 0.4.0, branch `feat/native-role-binding`. The living documentation is [role-binding.md](role-binding.md); this file records what was done, verified, and deliberately left out.

## Version relationship between the two repos

- Upstream base of this repo: `main` at `b44bb63cf` (release 0.4.0, 2026-08-13).
- Downstream HEAD: `3a02367ae` (0.4.0-paseo.5). Its merge commit `ebf9c5efd` merged upstream/main at `ab274d635`, which is **newer** than 0.4.0 (contains PRs #3287/#3394/#3446/#3450 that are not in this repo).
- Downstream-only change set: 138 non-merge commits (`git log --oneline --no-merges ab274d635..HEAD`), mixing the role-binding core with a much larger doctrine stack (Beads Central, SLP coordination, Council rooms, workspace-protocol v3 admission, assignment contracts, Antigravity AGY driver, Foundation distribution imports).

Because of that mix, the port took the design (ADR `docs/native-role-binding.md` downstream) and the core files, not a commit-range cherry-pick.

## What was ported

Protocol (`packages/protocol`):

- New `src/role-binding.ts`: `PASEO_ROLE_IDS` (lead/peer/supervisor), `PASEO_ROLE_DEFINITIONS_VERSION` ("1.0.0"), `PASEO_ROLE_SUMMARIES`, injection-method enum (5 values), `ProviderRoleBindingSupportSchema`, `isProviderRoleBindingSupportedForRole`, `RoleBindingReceiptSchema`.
- `messages.ts`: `roleBinding?` on `ProviderSnapshotEntrySchema` and `AgentSnapshotPayloadSchema`; `roleId?` on `CreateAgentRequestMessageSchema` (top level, next to `labels`). All optional — old clients and old daemons stay compatible; the AOT validators were regenerated (101 references compiled into `ws-outbound.aot.ts`).
- `agent-types.ts`: `ProviderSnapshotEntry.roleBinding` type mirror.

Server (`packages/server`):

- `agent/role-definitions.ts` (new): the three role definitions embedded verbatim from the demonthorn profiles (`profiles/roles/{_common,lead,peer,supervisor}.md`), joined universal + role blocks.
- `agent/role-binding.ts` (new): provider-family support resolution, legacy wrapper detection (`COMPAT(legacyProviderRoleDetection)`, expires 2026-09-30), `materializeRoleBinding` with sha256 definition/binding digests, `toRoleBindingReceipt` (strips instructions), `assertPersistedRoleBindingMatches`, `expectedInjectionMethod`.
- `provider-snapshot-manager.ts`: `getRoleBindingSupport()` computed per provider (family + legacy detection from the override's command argv); `roleBinding` attached to loading/reconciled/refreshed/error entries; `roleBindingSupport` exported via `AgentManagerProviderState`.
- `agent-manager.ts`: `roleId` on create options; rejection of `roleId` + `config.systemPrompt`; materialization before launch; `roleBinding` on the launch context, the managed agent, and `setAgentModel` rejection for bound agents; preserved across reload/resume; `dispatchArchivedStoredAgent` carries it.
- `agent-storage.ts` / `agent-projections.ts`: persisted `roleBinding` (with instructions) and wire receipt (without).
- `session.ts` + `create-agent/create.ts`: `roleId` plumbed from the RPC into both the session and MCP create commands; resume passes the persisted binding.
- Adapters: claude (preset append + native subagents off while role-bound), codex (`developerInstructions` on thread start, collaboration-mode settings), pi (extension file), omp (`--append-system-prompt`), mock (records the binding for tests). `AgentLaunchContext.roleBinding` added in `agent-sdk-types.ts`; `composeSystemPromptParts` was already variadic.
- `bootstrap.ts`: manager receives `providerRoleBindingSupport`.

App (`packages/app`) + client (`packages/client`):

- `daemon-client.ts`: `roleId` accepted on `createAgent` and sent on the wire.
- `composer/draft/input-draft.ts`: draft-local role state; picker gated on any snapshot entry reporting `roleBinding.status === "supported"`; provider/model lists filtered by role compatibility with auto-switch off incompatible providers.
- `composer/agent-controls/index.tsx` + `layout.ts`: role dropdown on desktop (badge-style, role-first, before the provider selector) and compact sheet (`AgentControlTrigger` + push combobox, `RoleIcon`); read-only bound-role badge on live agents; density accounting via `ComposerControlPresence.hasRole`.
- `workspace-tab.tsx`: `roleId` sent with the create request.
- `utils/agent-snapshots.ts`, `stores/session-store.ts`: `roleBinding` receipt mapped into the app Agent type.
- i18n: `agentControls.role.{fallback,select,title}` + `agentControls.hints.role` in all 9 locales.

## Verification

- `npm run typecheck`: protocol, server, client, app all clean.
- `npm run lint`: 0 warnings, 0 errors (three functions had to shed complexity points into helpers after the additions).
- `npm run format`: applied.
- Tests (each file run individually, per repo policy):
  - `packages/protocol/src/role-binding.test.ts` — 3 passed (new).
  - `packages/server/src/server/agent/role-binding.test.ts` — 28 passed (new): legacy detection, family resolution, fail-closed, materialization, receipts, snapshot exposure.
  - `packages/server/src/server/agent/role-binding-agent-manager.test.ts` — 5 passed (new): launch-context injection, systemPrompt rejection, fail-closed provider, model pin, persistence + reload with exact bytes.
  - `packages/server/src/server/agent/provider-snapshot-manager.test.ts` — 50 passed (existing suite, unbroken).
  - `packages/server/src/server/agent/agent-manager.test.ts` — 155 passed (existing suite, unbroken).
  - `packages/app/src/i18n` — 52 passed (locale key parity holds).
  - `packages/app/src/composer/draft/input-draft.test.ts` — 9 passed (existing suite, unbroken).

Not covered here: real-provider runtime canaries (spawn an actual claude/codex role agent and observe behavior). That matches the downstream's own bar, which treats runtime canaries as separate release evidence.

## Deviations from the downstream

- Dropped the doctrine layer entirely (workspace-protocol admission, assignment contracts/envelopes, Beads/Council tool ceilings and mandatory-tool gates, execution profiles, launch contracts with credential pinning, Cursor capsule and Antigravity AGY drivers, Foundation bundle import machinery). Role instructions here are the demonthorn profile bytes only.
- Downstream forces `unattended` for role creates; this port keeps the normal interactive default.
- Downstream pins `ROLE_CONTRACTS 3.2.0-topology-recovery`; here the definitions carry their own `PASEO_ROLE_DEFINITIONS_VERSION` ("1.0.0").
- Role summary descriptions no longer mention Workspace Protocol readership.
- The downstream attaches role instructions to the model picker via role profiles; here the picker filter is the only coupling.

## Known follow-ups

- MCP `create_agent` tool input does not expose `roleId` yet (the command layer accepts it; only the tool schema is missing).
- Agent list rows don't show the role badge — only the composer and snapshot payload carry it.
- The profile texts still reference `WORKSPACE_PROTOCOL.md`, `framework/`, AIT, and Semble, which are demonthorn-workspace concepts. They are injected verbatim by design; if a workspace lacks those files the model will see dangling references. Editing the bytes belongs to the demonthorn side and requires the version bump described in [role-binding.md](role-binding.md).
