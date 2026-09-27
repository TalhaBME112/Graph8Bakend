# Graph8 Growth Workspace

A working Angular frontend and Node backend for Buyer Deal Rooms, Campaign Learning Lab, and Run My Goal. Graph8 access uses `@graph8/sdk` on the server. Graph8 platform source code is not required or modified.

## Run

Requires Node 20.19+ and npm.

```powershell
cd D:\Graph8Bakend\Graph8Frontend
npm install
npm run build
npm run server
```

Open http://localhost:4301. The backend serves the compiled Angular application and its API. For frontend hot reload, run `npm start` in a second terminal and open http://localhost:4200.

The existing ignored `.env` supplies `G8_API_KEY` and `PORT`. The browser never receives the Graph8 API key. Verify the organization from **Connection settings → Verify Graph8 connection**. SDK authentication is independent of the MCP login. The running product does not rely on a Codex chat or an active MCP session.

## BidFlow — stateful agent graph for tenders

Open **Tender Workspace → ✦ BidFlow AI**. BidFlow is a LangGraph-style engine (`server/tender/bidflow/engine.mjs`): graphs of nodes that patch a shared state, fixed and conditional edges, feedback loops with a loop guard, and human-approval interrupts. Every step is persisted (encrypted SQLite + hash-chained audit), so runs can be inspected node by node and resumed after a restart.

| Layer | Where | Graph8 surface |
|---|---|---|
| Reasoning (✦ nodes) | `bidflow/llm.mjs` | A Graph8 **LLM skill** named "BidFlow Agent" (created automatically), executed and polled per node. Each node falls back to deterministic rules if the LLM is unavailable. |
| Prospecting & CRM (◆ nodes) | `bidflow/g8.mjs` | `@graph8/sdk`: open-index company/contact search, CRM companies, lists, companies, contacts, notes, campaign + email step, mailboxes. |
| Discovery | `bidflow/feeds.mjs` | Public procurement APIs (no keys): UK Contracts Finder, UK Find a Tender, World Bank, EU TED. Enabled feeds sync every 30 minutes. |

**Contractor Match (issuer)** — starts automatically when a tender is published, or from ✦ Suggest: parse tender → build contractor ICP → discover in Graph8 → score fit (rules + LLM) → *enough strong fits?* (⟲ broaden ICP → discover, max 2) → find decision makers → draft invitations → **issuer approval** → execute in Graph8 (list, companies, contacts, invitation notes, draft email campaign, in-app invites for registered suppliers).

**Bid Pursuit (bidder)** — from ✦ Pursue, or autopilot for strong new matches: discovery & Graph8 intel → parse → eligibility → *bid / no-bid* → estimation → bid generation → *red team* (⟲ reprice → estimation, ⟲ revise → bid generation, max 3 rounds) → **bidder approval** → execute (save or submit the bid; public notices are submitted on the official portal).

Safety: nothing is written to Graph8 CRM, submitted, or queued for outreach before the approval node. Invitation emails are drafted as a Graph8 campaign; launching it requires a connected mailbox and is done in Graph8. Contact emails are not enriched (no credits spent).

Optional environment variables: `BIDFLOW_MODEL` (default `gpt-4o-mini`; any id from Graph8 `skills/models`), `BIDFLOW_SKILL_ID` (use an existing LLM skill whose prompt has `{task}` and `{payload}`).

## Tender marketplace (peer to peer)

- **One account, both sides.** Every organisation account can publish tenders (My tenders) and bid on other organisations' tenders (Opportunities / My bids); nobody can bid on their own tender.
- **Bid tracking.** Each bid moves through Draft → Submitted → Opened → Under review → Decision. The buyer opening a bid, re-viewing it (deduplicated per 30 min), opening its attachments, evaluating, shortlisting and awarding are recorded as `bid-event`s and notified to the bidder. Scores are hidden from the bidder until the decision.
- **Tender documents.** Typed documents (specification, terms, BoQ, drawings, forms) with a download register; documents added after publication become addenda and notify bidders.
- **Official clarifications.** Numbered CL-001…, answers published to all bidders, asker anonymised for other bidders, optional clarification deadline, and buyer-issued notices. Clarifications do not invalidate submitted bids.
- **Messages, email, calls.** Conversations per tender/bid or organisation; channels: message, email (sent through Graph8 when a mailbox is connected, otherwise opened in the user's mail app and recorded), logged calls (outcome, minutes) and private notes. Contacts lists counterparties (email/phone from their account) and Graph8 suppliers invited by BidFlow.
- **Cold outreach (Contacts → Cold outreach).** Audiences are Graph8 lists (BidFlow supplier lists, Run My Goal lists). *Find work emails & phones* starts a Graph8 enrichment job (charges credits; explicit confirmation; job status and credits used are shown). *Verify emails* runs Graph8 email verification. *New email sequence* creates a Graph8 sequence with email steps; *Enroll selected* adds only contacts with a usable work email and requires a connected sending mailbox. Replies arriving in the Graph8 inbox raise notifications.
- **Notifications.** In-app bell for new bids, bid opened/reviewed/decided, messages and call logs, clarifications, tender changes, new documents and new tenders matching your supplier profile.

## Graph8 Growth layers (`server/growth/`, `src/app/growth/`)

- **Buyer Deal Room Studio** — *✦ New room from Graph8*: pick a real company from Graph8's open index and stakeholders from its contact graph; BidFlow upserts them, opens a Graph8 deal (default pipeline, Discovery stage), syncs stage readiness / buying committee / line items / quotes / notes, and the Graph8 LLM drafts a buyer-facing welcome + mutual action plan targeted at the missing stage requirements. Buyer views, tracked document opens, questions and milestone completions are logged in the room and mirrored to the Graph8 deal as notes. Actions: sync, AI plan, push plan to Graph8, Graph8 next-best-step, advance stage (confirmed).
- **Campaign Learning Lab** — *✦ Design with Graph8 AI*: single-variable test design from Studio GTM context and an optional Graph8 campaign; pre-registered power analysis (baseline, MDE, α, power → contacts per arm); audience imported from a Graph8 list with stable 50/50 assignment; *Create A/B arms in Graph8* (one list + one campaign draft per arm); decision framework reading live Graph8 campaign metrics (z-test, Bayesian P(B>A), expected loss, early-stop and guardrail rules); AI learning summary.
- **Run My Goal** — *✦ Plan with Graph8 agent*: a stateful agent graph (same engine as BidFlow): understand goal (GTM context) → audit GTM state → size the market in Graph8 → model the funnel → *enough audience?* (⟲ broaden, geography kept) → plan → **approval** → execute (A/B prospect lists + contacts, two campaign drafts with the sequence, a pre-registered Lab experiment, a buyer-room template). Progress and pace sync from Graph8 campaign metrics every 5 minutes.

Agent runs for goals persist in `server/data/growth.sqlite` (`GROWTH_DB` to override).

## Implemented journeys

### Buyer Deal Room

Create rooms locally or import a live Graph8 deal. Edit company details, add HTTPS resource links, maintain owner/date milestones, and allow selected milestones to be completed by buyers. Generate a seven-day bearer link, replace or revoke it, answer buyer questions, inspect page-load counts, refresh the linked deal snapshot, archive and restore rooms. Public responses omit private Graph8 deal identifiers and access credentials. Anyone holding the link can use the buyer page; the entered name is self-reported, not an authenticated identity.

### Campaign Learning Lab

Create an editable hypothesis with two variants and a success metric; add identifiers manually or from live Graph8 contacts. Stable hash assignment prevents duplicate enrollment and reassignment. The audience and design lock once tracking starts. Record individual outcomes manually, import a CSV atomically, or integrate the authenticated event API. Link two distinct Graph8 campaigns and refresh their numeric metrics. Aggregates are displayed as context and do not silently become experiment outcomes.

Observed conversions drive rates and 95% Wilson intervals. Missing outcomes are not failures. A lead is reported only on completion when both arms meet the configured minimum (at least 30), every assigned participant has an outcome, and intervals do not overlap. This is a conservative descriptive rule, not a power calculation or causal guarantee. Save a learning note, export assignments, and clone an empty follow-up experiment.

### Run My Goal

Set audience, outcome target, planning budget, and deadline. Review and edit the three-step starter plan: create an experiment, create a buyer room, create a Graph8 campaign draft. Activate, pause, resume, and mark the goal achieved after its target is recorded. Link progress to an experiment's confirmed conversions or record manual outcomes.

Optional local autopilot runs pending room and experiment steps every five seconds while the backend is running. It stops before the external campaign step. That step always requires explicit review and creates a real Graph8 campaign through the SDK with automatic document generation disabled. Nothing launches outreach or spends the planning budget. Every execution has a receipt. Uncertain external outcomes require reconciliation against an existing Graph8 campaign instead of automatic retries.

This is deterministic workflow automation with editable plans; it is not an LLM planner. The budget is a planning field, not an enforced Graph8 spending limit. Autopilot is active only while the single backend process runs.

## Persistence and access

Workspace state is saved to `server/data/workspace.json` through serialized atomic file replacement. Restarting the server retains records. Set `G8_WORKSPACE_FILE` to change the location. Only one backend process may own a file; this is a single-workspace app, not a multi-tenant service. Back up the state file or download a backup in Connection settings. Backups contain buyer links and event credentials and must remain private.

Default binding is `127.0.0.1`, and local administration is accessible from this computer. Set `ADMIN_TOKEN` to require a workspace token even locally. Enter that token (not the Graph8 API key) in Connection settings; it is stored in browser session storage.

For remote hosting, configure `HOST`, a strong `ADMIN_TOKEN`, and an HTTPS `APP_ORIGIN`; use a TLS reverse proxy forwarding the configured Host. Remote binding is refused without the token and HTTPS origin. A localhost buyer link works only on the same computer. Public hosting, a domain, TLS, and operational monitoring have not been provisioned. For a multi-user SaaS deployment, replace shared-token administration with user authentication/RBAC, use a transactional database and job queue, and add deployment-specific rate limiting and backups.

## Event API

Generate an event key in the experiment's **Connected outcomes** panel. Keep it in the integration backend and rotate it if needed. Only running experiments accept events.

`POST /api/events/experiments/:experimentId`

Headers:

```text
Content-Type: application/json
X-Workspace-Client: event-adapter
X-Experiment-Key: <experiment credential>
```

Body:

```json
{
  "eventId": "unique-provider-event-id",
  "contactId": "already-assigned-contact-id",
  "converted": true,
  "occurredAt": "2026-09-26T12:00:00Z"
}
```

Use the actual outcome time. Repeated event IDs are ignored; unknown contacts, stale outcomes, and future timestamps are rejected. Rotation invalidates the previous key. This generic adapter endpoint is not a preconfigured Graph8 webhook subscription.

CSV outcome import expects `contactId,converted` followed by one identifier and `true` or `false` on each line. It intentionally supports simple identifiers without embedded commas. Assignment export additionally includes variant and pending outcomes; it is a separate reporting format.

## Verification

```powershell
npm run test:server
npm test -- --watch=false
npm run build
npm run test:e2e
```

Browser tests use installed Microsoft Edge, an isolated server on port 4398, no Graph8 credentials, and a separate temporary state file. They cover room creation, buyer completion and Q&A, link revocation, experiment assignment and outcome import, learning notes, local goal automation, reload persistence, and mobile overflow. Tests never launch live campaigns. Screenshots are written under `test-results`.

Live read-only SDK checks are separate from fixture tests. A successful read in an empty organization confirms authentication and API response handling; it does not verify campaigns with real metrics. Live campaign creation and production deployment require verification in the intended environment before claiming production readiness.

## Main files

- `src/app/app.ts`, `app.html`, `models.ts`: application state, templates, and types.
- `src/_growth.scss`: responsive visual system.
- `server/index.mjs`: HTTP API, access boundaries, static hosting, and execution scheduler.
- `server/features.mjs`: event ingestion, editing, imports, snapshots, and reconciliation.
- `server/graph8.mjs`: server-only SDK calls.
- `server/domain.mjs`: validation, experiment calculations, and record factories.
- `server/store.mjs`: durable local persistence.

The sibling ASP.NET starter is not used by this implementation. Run the Node server above for the functional backend.
