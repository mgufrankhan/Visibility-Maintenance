# What to take from remberg

Status: S1–S5 completion trigger implemented (the next due follows the previous closure). Directory sign-in remains blocked. D41 is accepted. D36–D40 and D42 remain proposed. Date: 23 October 2026.

This document records which public remberg capabilities belong in Visibility Maintenance, which stay outside it, and the order to build the included ones. It does not change the product requirements until a phase below is accepted. Core, Connected Operations, Neo and predictive models keep their existing gates.

Related: `docs/00_PRODUCT_PRD.md`, `docs/05_UI_AND_USER_FLOWS.md`, `docs/07_NEO_AGENT_SPEC.md`, `docs/10_IMPLEMENTATION_BACKLOG.md` phases 0–8, `docs/12_DECISIONS_AND_DISCOVERY.md` (D36–D42), `docs/13_COMPLETION_REPORT.md`, `docs/14_PREDICTIVE_MODELS.md`.

Source for the remberg column: remberg.com public pages on 22 October 2026 (CMMS, EAM, AI copilot, mobile app, pricing, SAP integration). Customer quotes on that site, including availability gains, are remberg’s claims.

## 1 Already in this product

remberg’s daily maintenance loop matches work that phases 0–8 already implement locally. These items stay as they are. This plan does not rebuild them.

| Capability | Where it lives |
| --- | --- |
| Asset identity, hierarchy, criticality, QR | Platform registry plus maintenance profile |
| Fault request, triage, photo evidence | Requests |
| Fixed work-order lifecycle, labor, evidence, independent close | Work orders |
| Calendar preventive plans and typed inspections | Plans and inspections. Checks already include pass/fail, numeric, text, photo and acknowledgment |
| Downtime, MTTR, MTBF, PM compliance, cost, repeat faults | Reports |
| Offline drafts on the PWA, with visible sync conflicts | My Work |
| Cited drafts that a person must approve | Neo recommendations. The assistant cannot close work or write to machines |
| Parts ledger and a chosen external CMMS as record authority | R2. A live HTTP adapter stays unqualified until a customer system is contracted |

A SAP connection, if a customer needs one, is an instance of that CMMS authority contract. It is not a separate core adapter and it is not an SAP partnership claim.

## 2 Include

Take the shop-floor habits that get work recorded. Each row is specified in the phase that builds it.

| Feature | What to build | Phase |
| --- | --- | --- |
| Acknowledgment time (MTTA) | Deterministic report from request timestamps, beside the existing metrics | S1 |
| Signature on procedures that require one | Named signer, time and procedure-snapshot hash stored as completion evidence | S1 |
| Conditional procedure steps | A later step appears only when an earlier check fails or a numeric reading is outside its limits | S1 |
| Planning board | Open work grouped by person and site-local day, with site shift windows. Schedule edits use the current work-order rules | S1 |
| Pre-job briefing | Deterministic pack of open work, recent failures, the issued procedure and parts coverage. An optional Neo narrative stays a recommendation | S2 |
| Voice or text into structured fields | A reviewed draft of symptom, cause, action and notes. The original words remain | S2 |
| Request translation | Original text stays the audit record. A translation is shown only when the site has more than one working language and a qualified runtime exists | S2 |
| Parts ready before PM is due | A plan lists expected parts. A shortage is visible. Generation continues unless the site explicitly blocks on shortage | S3 |
| Parent order for a planned shutdown | One coordinating order and child orders per asset. Children own labor, evidence and downtime | S4 |
| Completion-relative preventive schedules | A new trigger anchored to approved completion, after the recurrence rule is written down | S5 |
| Directory sign-in | SAML or OIDC against a customer directory. Local accounts remain | S5, blocked on a real directory (D08) |

## 3 Leave outside this plan

| remberg capability | Why it stays out |
| --- | --- |
| Cloud-only hosting | Private install and a local license remain the release target (D04) |
| Facilities, field service, fleet, white label | This product is factory maintenance |
| Custom work-order statuses | The audited lifecycle stays fixed. Sites label priority, failure codes and teams |
| Open agent builder | Neo stays on the allowlist, with the caller’s permissions and a bound approval |
| Floor plans | Hierarchy, location and QR locate equipment |
| Native phone app as a requirement | The technician path remains the PWA (D14). Revisit only if shop-floor use rejects the browser |
| Capital planning and repair-versus-replace | Later enterprise-asset assessment, with predictive models in `docs/14_PREDICTIVE_MODELS.md` |
| SAP-specific goods-issue posting as core | External record authority stays generic and unqualified until a customer contract exists |

## 4 Rules for every phase

- Core works with Live, OpenRemote, Neo, sensors and a GPU absent. S2 narrative, transcription and translation are optional. The deterministic briefing, signature, conditional steps, board, MTTA, parts warning and parent orders do not call a model.
- A model draft is a recommendation. Applying it is a normal, permission-checked write by a person. The proposer cannot approve it.
- Issued procedure snapshots stay immutable. New check rules and signature requirements apply to revisions published after the change.
- Tenant and site scope apply to reads, writes, attachments, exports and background jobs.
- Material schedule edits follow the existing reapproval rule. The board does not invent a workflow state.
- Phases are dependency order, not dates. S0–S5 do not block docs/09 customer acceptance, connector qualification, the Neo 40-case evaluation or phase 9 predictive work.
- Do not advertise a remberg parity claim, a percentage reduction in admin time, or a qualified SAP connector from this plan.

## 5 Phases

```text
S0 decisions
  → S1 records and board (no Neo, no parts)
    → S2 briefing and structured capture (Neo optional)
    → S3 parts readiness (needs the phase 8 ledger)
    → S4 shutdown parents (needs S1 schedule edits)
      → S5 completion-relative plans, and directory sign-in when a customer IdP exists
```

S3 can proceed in parallel with S2 once S0 is accepted. S5 completion-relative work waits on a written recurrence rule and does not wait on S3 or S4. Directory sign-in waits on a customer identity provider.

### S0 — Lock the boundary

No product code.

- Accept the include and leave-out tables and decisions D36–D42.
- Name the pilot site’s working languages, whether any procedure requires a signature, and whether shutdowns across several assets are in the first pilot. Missing answers defer S2 translation, S1 signatures or S4. They do not defer MTTA, conditional steps or the board.

Exit: this document is the requirements home, and open pilot questions have owners or an explicit deferral.

### S1 — Finish the job without an assistant

Depends on the local phase 2–4 work orders, procedures, inspections, offline sync and reports.

**MTTA.** Add `mtta` to `REPORT_METRICS` in `packages/core/src/reports.ts` and the report contract. Definition: for requests accepted in the period, elapsed time from `submitted` to `accepted`, in hours, with the request ids. Rejected requests are a separate count and are excluded from the average. Requests still open are listed and excluded from the average. Zero accepted requests return the open and rejected counts and no invented average. Permission is `maintenance.report.view`. Multi-site uses the existing multi-site runner. Export follows the same permission.

**Signature.** A published procedure revision may set `signature_required`. Submission of a work order or inspection that carries that snapshot must include a completion signature: acting user, signed-at time, and a hash of the procedure or inspection snapshot. This is an acknowledgment bound to the signer and the snapshot. It does not replace `acknowledgment` checks inside the checklist. A missing required signature blocks submission the same way missing mandatory evidence does. Corrections are amendments. The offline queue may carry the signature operation; the server rechecks permission, snapshot hash and record version. A hash mismatch is a visible conflict.

**Conditional steps.** Extend `checkDefinition` in `packages/contracts/src/maintenance.ts` with an optional `visible_when`: a prior check key plus `failed`, `passed`, or `outside_limits` (numeric min/max already on the check). A hidden check is not required and is stored as not applicable. Cycles and forward references are rejected at publish time. The issued snapshot freezes the rules. A failed visible mandatory check still opens one reviewable request, as inspections do today.

**Planning board.** Extend `apps/maintenance-web/src/screens/work.tsx` so open orders can be grouped by assignee and site-local day. Site settings gain shifts: code, label, start minute and end minute in the site timezone. Dropping an order on a day or shift writes `planned_start` and `planned_end` through the existing work-order patch. If that patch is a material change, the API returns the order to pending approval under the current rule. Stale edits return 409 or 412. The board adds no workflow state.

Touch `packages/contracts`, `packages/core` work orders, inspections and reports, maintenance migrations, `apps/maintenance-web` work and settings screens, and integration tests.

Exit:

- MTTA fixture: accepted, rejected, still open, and an empty period.
- A required signature blocks submit; a matching signature allows it; a snapshot change after signing conflicts.
- A hidden conditional step is not required; a failed visible step creates one request.
- A board move on a stale version conflicts, and a material date change re-enters approval.
- The same flows pass with Neo disabled.

### S2 — Briefing and structured capture

Depends on S1 snapshots and the phase 7 recommendation records. The deterministic pack ships even when the model evaluation is still blocked.

**Briefing.** `GET` a briefing for an asset, or for a draft order’s asset, in the caller’s site. Return open orders, recent validated failure events, the current procedure revision id, linked documents the caller may read, and parts coverage when the ledger is present. Numbers come from the report and parts services. The response cites record ids. Neo may add `draft_briefing` as a recommendation whose narrative quotes those ids. Assigning the order remains the existing transition. Applying the narrative does not publish a procedure or close work.

**Structured capture.** On a request or an in-progress order, accepted text or an already-stored audio attachment creates a recommendation with proposed symptom, failure code if one matches the site list, cause, action and notes. A person applies the proposal through the normal request or work-order write. The original text or audio stays. Without a qualified transcription runtime, audio is stored and no transcript is invented. Typed text can still be split into the proposal by the deterministic runtime when the user marks the fields, and otherwise remains a note awaiting edit.

**Translation.** Site settings may list `working_languages`. With one language, no translation control is shown. With more than one, a recommendation may carry a translation of the request description. The submitted description is immutable except by amendment. The screen shows the original and, when present, the translation labeled with its source language. Without a qualified runtime, the original is shown and the translation slot stays empty.

Touch `packages/core/src/neo.ts` only for the optional narrative and field proposal, plus request and work-order read models and the request screen.

Exit:

- Briefing returns with Neo off.
- A recommendation cannot be decided by its proposer.
- Applying a translation does not overwrite the original description.
- Instructions embedded in the submitted text or audio do not change tools, roles or policy.
- Failed model calls leave request create, triage and work execution usable.

### S3 — Parts ready for the next occurrence

Depends on the phase 8 parts ledger. Independent of S2 and S4.

A plan revision may list expected parts: part id and quantity, same site. Publishing validates that each part exists and is stocked for that site. On generation, compare the list with on-hand quantity minus open reservations. A shortage is stored on the plan as a visible issue, same family as `last_generation_issue`, and the occurrence is still issued. Site policy `pm_block_on_shortage` defaults off. When it is on, the occurrence is recorded as blocked and no order is issued. Turning the policy on is an audited settings change. This phase creates no purchase order and posts no goods issue to an external ERP.

Touch plan revisions, the scheduler, `apps/maintenance-web/src/screens/plans.tsx` and `parts.tsx`.

Exit: shortage visible while the order still generates; explicit block policy suppresses that occurrence once; a part from another site is rejected; retries do not double-issue.

### S4 — Parent order for a planned shutdown

Depends on S1 so the parent appears on the board. Single-asset closure behavior stays the default.

A work order may set `parent_id` to another order in the same tenant and site. The parent uses a non-asset category `shutdown` and has no asset id. Each child has one asset and the normal lifecycle, procedure snapshot, labor, evidence and downtime. The parent does not accept asset evidence, labor or a downtime interval. PM generation never creates a parent or a child link. Closing the parent requires every child to be closed or cancelled. Reopening a child reopens the parent with a reason and keeps the previous parent closure. Cancelling the parent cancels no child automatically; the supervisor cancels or relinks children explicitly. Offline sync continues to cover assigned child orders. Parent create, link and schedule edits require the server.

Touch work-order schema, transitions, downtime linkage and `screens/work.tsx`.

Exit: two child assets record their own downtime; the parent adds none; early parent close is rejected; a cross-site child is rejected; repeating the link call does not duplicate the child.

### S5 — Completion-relative plans and directory sign-in

These two tracks are independent. Either may wait.

**Completion-relative trigger.** Adopted in D41. The verifier’s closure of a cycle is the anchor. The release-to-work `approved_at` is not.

- The first occurrence is due on the plan anchor date and time of day, because no cycle has been closed.
- Each later occurrence is due one interval after the previous closure, at the same time of day in the site timezone.
- A cancellation without an exemption moves the anchor to the cancellation time.
- A cancellation with an approved exemption does not move the anchor. That due may be issued again.
- Reopening a closed order keeps the anchor at the original closure until the new cycle is closed.
- At most one open occurrence per plan and asset remains in force.
- Month-end clamping matches calendar plans.
- The trigger is not combined with a meter trigger.
- Pause stops future generation and does not cancel the open order.

Implement the trigger beside calendar and meter generation in `packages/core/src/pm.ts`.

Exit: fixtures for completion, exempted cancellation, reopen, pause and month-end. A second worker retry issues one order.

**Directory sign-in.** Remains blocked until a customer directory is available (D08, D42). When it is, add an authorization-code flow with PKCE against that provider, map agreed claims onto the existing tenant user, and keep local break-glass accounts. Do not add a second user directory. Do not claim an external IdP from a mock.

Exit: a contracted test provider signs a mapped user into an existing tenant; an unknown claim is rejected; local login still works for the break-glass admin; network loss during a valid local session does not disable Core.

## 6 Decisions

Proposed until adopted in `docs/12_DECISIONS_AND_DISCOVERY.md`. S1–S5 completion scheduling was implemented against the rules in this document. D41 is accepted. D36–D40 remain proposed. D42 stays blocked with D08.

| ID | Choice |
| --- | --- |
| D36 | Shop-floor adoption lives in this document. It does not reopen phases 0–8 or phase 9, and it does not change the PRD until a phase exit is accepted |
| D37 | Briefing, structured capture and translation are review-first. The deterministic briefing works with Neo absent. No transcript or translation is invented without a qualified runtime |
| D38 | Lifecycle states stay fixed. The planning board writes schedule fields through the current patch and reapproval rules |
| D39 | A required signature is completion evidence bound to the signer and the snapshot hash. Conditional steps extend `checkDefinition` and freeze on the issued snapshot. Hidden steps are not required. Failed visible checks still open one request |
| D40 | Parts readiness warns by default. `pm_block_on_shortage` is off unless an administrator turns it on. No purchase or ERP goods issue is added here |
| D41 | Completion-relative recurrence uses the closure of the previous cycle as its anchor. The rule is accepted |
| D42 | Directory sign-in stays on D08. This plan does not implement a provider without a customer directory |

## 7 Verification

For each phase, before calling it done:

- `npx tsc -p tsconfig.json` and `npx tsc -p apps/maintenance-web/tsconfig.json`
- `npx vitest run` covering the new fixtures
- Browser pass of the changed screen: board move, signature submit, conditional checklist, briefing with Neo off, parts shortage, and parent close, according to the phase
- Permission denial, stale version, and offline conflict where the phase touches those paths
- A note in `docs/13_COMPLETION_REPORT.md` listing what was verified locally and what is still blocked

S2 model quality stays inside the existing 40-case Neo gate. Passing S2 deterministic behavior does not qualify a model. S5 directory sign-in does not qualify an IdP until the customer provider is tested.
