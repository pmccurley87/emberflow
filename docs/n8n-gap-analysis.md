# Emberflow vs n8n — Gap Analysis

Date: 2026-07-02. Source: `.superpowers/sdd/n8n-feature-report.md` (docs.n8n.io research)
compared against Emberflow at commit `63716ce`. Ordered easiest-win first within each tier.
Framing: Emberflow is a developer-centric replacement — node bodies are real code,
authored by AI agents; we take n8n's UX patterns, not its low-code positioning.

## Already at parity (or better)

- Canvas authoring, typed per-field input handles (better: n8n maps via expressions,
  we map visually per field with typeahead).
- Run + step-through (step is native to our executor; n8n has no true step mode —
  only partial runs).
- Execution history with replay-into-view, per-run logs (n8n gates "Debug in editor"
  behind Cloud/registered tiers).
- Node implementation visibility (View code) — n8n hides node internals entirely.
  This is our thesis feature.
- Multi-workflow sidebar, JSON export/import, workspace persistence.
- Graph validation before run (n8n validates lazily at execution).

## Tier 1 — easy wins (hours→days each)

1. **Keyboard shortcuts** — Cmd+Enter run, N/Tab add-node, D disable, F2 rename,
   Del, Cmd+A/click multi-select, Cmd+D duplicate. Pure UI.
2. **Node duplicate + copy/paste** — store ops; clipboard JSON gives cross-workflow
   paste for free.
3. **Node disable** — engine treats disabled as pass-through/skip; UI toggle + dimmed
   style. Decide semantics up front (n8n never documented theirs).
4. **Per-node execution timing on canvas** — we already record startedAt/completedAt;
   just render duration chips after runs.
5. **Note/sticky node** — planned phase 5; markdown body, resizable, colors.
6. **Drag-edge-to-empty-canvas opens Add-node picker, auto-connects** — n8n's best
   connect gesture; we have the picker already.
7. **Node context menu** — right-click: duplicate, disable, delete, run-to-here (stub
   until partial runs land).
8. **Undo/redo** — zustand history middleware (zundo) over the flow slice.

## Tier 2 — medium (the phase-4/5 backlog, ~week each)

9. **Isolated node run modal + previous-input replay** — already designed (trace sink
   captures every execution's input/output). n8n equivalent: NDV Execute-step.
10. **Data pinning** — feed a recorded output instead of executing the node
    (dev-only). The trace sink already stores exactly what's needed; this is the
    agent-iteration killer feature (iterate downstream without re-hitting APIs).
11. **Partial runs / dirty-node tracking** — run-from-node using cached upstream
    outputs; n8n's "dirty nodes" model is the reference.
12. **Route/IF/Switch node** — planned phase 5; per-branch output handles, enum-aware.
13. **Merge node** — blocking join with append/combine-by-key modes. Needed for any
    fan-in graph.
14. **Retry + on-error policy per node** — n8n's On Error (stop / continue / error
    output) + Retry On Fail. Straightforward executor extension; big prod-credibility
    win.
15. **Inline transforms on mappings** — `FieldMapping.transform` already exists in the
    data model, unused. Deliberate divergence from n8n: no `{{ }}` templating
    language — transforms are code snippets (our thesis: code beats expression DSLs).

## Tier 3 — structural (need the engine/SDK milestone)

16. **Items/array model + ForEach (Split in Batches)** — n8n's core data model is
    items-with-lineage (pairedItem). We're scalar-first; first list-shaped API hits
    this wall. ForEach node planned; item-lineage worth stealing.
17. **Triggers (webhook, schedule)** — requires a server-side runtime; belongs to the
    embedded-SDK/production milestone, not the browser prototype.
18. **Sub-workflows (Execute Flow node)** — multi-workflow store makes this natural;
    child flow declares input schema (we already have schemas — cleaner than n8n).
19. **Credentials management** — the very first blocker for real-world APIs (we dodged
    it by picking keyless Open-Meteo). Needs the server runtime + encrypted store;
    in-browser secrets are a non-starter.
20. **Error workflows** (flow-level failure handler) — pairs with #14.
21. **Wait/resume durability** — Temporal-shaped; the trace-sink/durable-executor
    story covers this later.
22. **Versioning/environments/sharing** — ops tier. Flow-hash pinning is already in
    the vision doc and beats n8n's snapshot-only history for the replay-integrity
    story.

## Strategic notes

- n8n now ships an **AI Workflow Builder** (prompt → workflow, credit-metered).
  Emberflow's answer is structurally different: the agent isn't a bolted-on
  assistant, it's the primary author working through CLI/MCP with the graph as the
  artifact. That, plus visible node source code, is the moat — n8n can't show code
  that doesn't exist.
- The browser-only engine hit its ceiling with real infrastructure: CORS + no
  secrets. The next real-API integration should force the engine extraction
  (headless/node execution) — which is also what triggers, credentials, and the SDK
  all need. One milestone unlocks four gaps.
