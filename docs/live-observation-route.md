# NQ observation route — contract, scope and verification

## Approved scope

The user approved the proposed offline implementation: bounded Node acceptance,
fixed Electron IPC, preload, renderer and the existing 250 ms display cadence,
using artificial input only. No actual data connection, credentials, raw data
persistence, public Preview feed, order or payment operation is enabled.
The existing normalized MOCK AnalysisHub and its numerical goldens are unchanged.

## Provider evidence and unresolved meaning

Public documentation was fetched during implementation (2026-10-25 JST).
This is documentation evidence, not account-specific entitlement evidence.

| Subject | Public source | Contract applied here |
| --- | --- | --- |
| Root NQ | https://tick-stream.xyz/docs/symbols | CME E-mini Nasdaq-100, automatically rolling front-month continuous, no back adjustment. A specific expiry cannot be addressed. |
| Individual expiry | Same source | `/v1/symbols` is documented to report `contract` and `contractSince`. No authenticated catalog request was made. No mapping of a particular tick/book frame to a particular expiry is established. Keep contract null. Never fill a current or MOCK expiry. |
| Roll | Same source | Roll windows watch both contracts but publish front-month prints. `contractSince:null` is unverified, not proof of no roll. Do not aggregate across inferred expiries or fabricate session anchors. |
| Exchange session | Tick/book message schemas below | No exchange-session identifier is documented in those frames. Keep null. Connection generation is only local lifecycle identity, not an exchange session. |
| Tick time | https://tick-stream.xyz/docs/streaming | Integer Unix seconds. Multiplication to ns does not create subsecond source precision. Receive UTC is a separate local clock. |
| Sequence / Trade ID | Tick/book schemas | No provider sequence or Trade ID in reviewed profiles. Local receive ordinal is not either of them. Identical tick deliveries are not silently deduplicated; no exactly deduplicated volume total is claimed. |
| Book | https://tick-stream.xyz/docs/level2 | Every frame is a full aggregated Snapshot, up to 400 levels per side for NQ/ES. Latest state is coalesced to at most approximately 7 Hz, not every intermediate change. Replace, do not merge as deltas. |
| Coverage | Same source | A full reported ladder does not establish a complete time history, sequence continuity, or zero quantity for an omitted price. coverage UNKNOWN; omissions UNKNOWN. |
| Side / imbalance | Streaming and Level2 sources | Side is provider-declared, unverified aggressor evidence. Book imbalance is not Trade Delta. Neither certifies completeness, finality, or exact dedup. |
| Permissions | Level2 source requires Realtime + L2 | Public product description is not proof of this account's permissions. Actual connection remains disabled; the separate authentication/entitlement work must not be bypassed. |

No credentials were accessed to fetch these public documents.

## Route and runtime boundary

1. `packages/tickstream-adapter/src/analysisObservation.ts` reuses the existing
   strict parser and receive-provenance wrapper. Unsupported frames fail closed.
2. `packages/core/src/liveAnalysis.ts` accepts a separate observation contract.
   `analysisHub.ts` re-exports it without relaxing normalized MOCK validation.
   A root observation cannot satisfy the existing expiry-qualified MarketEvent
   contract. It therefore is **not** converted into a fake normalized event.
3. `apps/desktop/main/liveController.ts` owns a RAM hub per generation, with
   only one fixed `orderflow:observations:v1` handler registered by main.
   Renderer requests contain only a fixed operation and integer generation.
   Raw input and synthetic-source selection are Node-internal test seams, not
   preload methods, URL parameters, renderer flags or public API routes.
4. `vite.main.config.mts` bundles the existing workspace ESM/TS parser/core into
   CJS for Electron. Preload is standalone and requires only Electron.
   A Windows stage that copies only built assets does not need source TS files.
5. The sandboxed preload exposes select/read/stop/release only. Main validates
   the owned webContents, the exact main frame, and the exact local document URL.
   Native security settings and the network-denying production CSP remain intact.
6. `renderer/observationSession.ts` serializes read requests at the existing
   250 ms cadence, with a finite 2 s request deadline. Old selections/responses
   are released or ignored. No unbounded push queue or per-tick React update.
7. `DesktopHost.tsx` switches independently mounted MOCK/observation views.
   App/ChartShell feed the existing HeatmapCanvas, BubbleCanvas, DeltaPanel,
   and LadderPanel. No second computation or coordinate-transform engine.

Main currently has no feed connector and rejects actual-origin injection.
Only the Node-internal synthetic test seam enables wire input. The core's
actual-origin observation contract is testable without starting a connection.
Turning on real reception is not implied by the presence of these modules.

## Display contract

All four section revisions equal the frame revision, including clear/stop/stale
updates. Each frame contains root NQ, null expiry/session, second precision and
UNKNOWN coverage. Simulated input is labelled SIMULATED / LIVE PIPELINE.
An unconnected actual-source scope is labelled LIVE HOLD / NOT CONNECTED.

- **Ladder:** latest received Snapshot entries only, explicitly **not current
  market quantities**. Listed zeros are retained. Unlisted prices are unknown.
  No market Best, FULL completeness, canonical expiry or exchange session is
  fabricated. Existing ladder geometry/density and row rendering are reused.
- **Heatmap:** TWA NO DATA, not a time-weighted hold of coalesced snapshots.
- **Bubble:** finalized/complete aggregate NO DATA. A local receive ordinal is
  not substituted for an exact provider Trade ID.
- **Delta:** NO DATA, not zero. Provider side alone does not establish a
  complete, deduplicated signed volume history.
- **Trade diagnostic:** last received price/volume/side/time may be displayed
  as one observation, explicitly not a total. Volume Profile receives no
  invented trades.

These withheld analytics are the defined behavior for the supplied unresolved
root feed, not a claim that exchange-grade analytics have been verified.

## Capacity and lifecycle

The parser's existing 1 MiB UTF-8 input bound and 400 levels/side remain.
The finite hub also caps 800 levels, 20,000 observations and 16 MiB cumulative
normalized input; IPC replies cap at 256 KiB. These safety budgets are specific
to this bounded offline route, not a licensed or production retention policy.
There is no history eviction, silent truncation or persistence.

Each local receive ordinal must increase within its generation; it never
certifies provider ordering or exact dedup. Stale-generation input is ignored,
stale-generation commands rejected. Stop, capacity failure, malformed input and
navigation clear held observations. A book older than 2 s on the Node monotonic
clock is cleared; this local cutoff is not proof of market-time freshness.
Renderer IPC failure/timeout clears the frame and terminates polling.
Source switch/unmount cancels timers and releases the generation; a select
reply that arrives after disposal is released without publication.
Window close, renderer loss and app quit dispose the Node scope.

## Verification

- `pnpm run typecheck`: PASS across workspace.
- `pnpm test`: original core/render/web/storage/local-gateway/desktop suites
  PASS; the MOCK fixtures and numerical expectations were not modified.
- `pnpm --filter @workspace/tickstream-adapter run test`: PASS.
- `pnpm --filter @workspace/desktop run build`: PASS; bundled CJS main/preload
  actually loaded in Electron, not just a TypeScript compilation.
- Synthetic wire integration covers parser → Node hub → fixed command boundary
  → renderer publication → display projection, quantities 17 / 0 / UNKNOWN,
  four equal revisions, snapshot replacement, late generation, sender refusal,
  unsupported/oversized input, stop and cleanup. Static rendering checks LIVE
  HOLD and SIMULATED labels and absence of MOCK controls in observation mode.
- Native Linux Electron smoke: normal GL initialization failed with
  `glXQueryExtensionsString returned NULL` / `CANVAS_MISSING`. This is retained
  as a failed physical/default GL attempt, not reported as PASS.
- The already-supported smoke-only SwiftShader option passed baseline13
  revision 13, goldens, real canvas/revision/resize/DPR checks, the actual
  production-CJS main/preload HOLD route, stop, generation restart and React
  unmount. This is software WebGL functional evidence, **not physical GPU
  performance or Windows 11 verification**.
- Native evidence (generated, Git-ignored):
  `.local/diagnostics/live-route-native/result.json` (failed default GL) and
  `.local/diagnostics/live-route-native-software/result.json` (PASS), plus
  native screenshots. No real market payloads are present.

Not performed: actual provider connection, authenticated catalog queries,
Windows build/ASAR execution, Windows monitor/DPR tests, physical GPU performance,
live completeness/roll/session validation, persistence or load-stage certification.

## Prerequisite decision — HOLD (2026-10-25 JST)

The user explicitly chose to maintain HOLD because the separate authentication
and entitlement prerequisites remain unresolved. The existing conclusion in
`docs/live-connection-permission-investigation.md` has not been superseded by
new evidence. No authentication or L2 entitlement investigation was repeated.

This decision is a stop, not approval to design or verify a catalog-to-frame
mapping. No authenticated catalog request, actual connection, market-data
persistence, product-code change or analytics enablement was performed.
The existing null contract/session and NO DATA analytics remain unchanged.
The verification results above belong to the earlier offline implementation;
they do not verify expiry/session mapping or grant permission to enable it.

Deferred until the separate prerequisites are resolved and additional approval
is given:

- Establish whether provider `contract` / `contractSince` can identify each
  frame without guessing, including delayed delivery and roll boundaries.
- Establish exchange-session evidence independently of local connection
  generations, timestamps and receive ordinals.
- Design and verify rejection of ambiguous identity and prevention of
  cross-contract aggregation at roll. Do not invent Trade IDs, sequence or
  coverage when the provider evidence is absent.

After those steps, calculation enablement still requires separate approval and
must reuse the existing engines. Neither a catalog value nor a resolved session
alone establishes completeness or exact deduplication. No automatic connection
or persistence is authorized by this decision or by later offline verification.
