# Neo maintenance assistance specification

Neo is optional and cannot be a dependency for work orders, calendar PM, inspection entry or deterministic condition detection. Local inference and retrieval serve private-only deployments; cloud calls require a permitted customer policy.

## Initial assistant functions

Answer equipment questions from approved documents and work history. Explain a validated condition using source-labeled summaries. Draft maintenance requests, checklist suggestions and shift summaries. Identify missing information and propose inspection. Do not diagnose from unsupported assumptions or replace engineering approval.

Retrieval sources include authorized manual revisions, SOPs, issued procedures, work records, distinct failure events and selected telemetry evidence. Attaching manuals is part of Core; Neo retrieval is the optional capability. An external Docs service may be reused without making it mandatory for Core.

## Tool definitions

| Tool | Input scope | R1 behavior |
| --- | --- | --- |
| search_asset_knowledge | asset, query, permitted revisions | Read scoped evidence and citations |
| get_maintenance_history | asset, date window, authorized site | Read relevant repairs and failures |
| get_signal_summary | asset/signal/window | Return deterministic values, source and freshness |
| get_maintenance_metrics | asset/site/period | Call reports service; no model-computed KPI |
| draft_request | asset/location, evidence, proposed priority | Persist reviewable draft only |
| draft_work_order | request, title, proposed procedure | Persist draft through ordinary API policy |
| propose_checklist | asset/procedure references | Suggest changes for review, not publish a procedure |

No tool closes work, approves its own recommendation, restarts equipment or writes control setpoints. Future automatic low-risk actions need a separately evaluated policy. Draft tools still require idempotency and authorization.

## Response contract

Return observations, source freshness, possible causes, recommended checks, citations, missing evidence and proposed action. Citations reference document revision/page or record ID. Distinguish facts from hypotheses. Abstain on conflicting or absent safety instructions rather than inventing a procedure. Confidence scores are omitted unless calibrated and validated.

## Agent run and approval

Store run ID, trigger, actor/service identity, tenant/site, evidence IDs, model/prompt versions, retrieved revisions, tool decisions, draft IDs, approval binding, execution result and follow-up. Avoid storing exposed credentials or unnecessary raw personal data. Schedule identities have narrow grants.

Documents are untrusted data. Their embedded instructions cannot alter tools, role scope or policy. Apply retrieval filtering before context is sent to a model and recheck tool authorization before execution. Changed payload/version invalidates approval. AI timeout must leave a useful non-AI workflow.

## Evaluation

Use at least 40 engineer-reviewed cases covering grounded troubleshooting, no manuals, conflicting revisions, stale readings, missing hours, prompt injection, forbidden assets and unsafe requests. Require zero unauthorized tool executions and zero uncited safety-critical recommendations. At least 90 percent of otherwise answerable cases must satisfy the agreed grounding and relevance rubric. Record model/runtime and case results. Failed cases block affected AI features, not Core.
