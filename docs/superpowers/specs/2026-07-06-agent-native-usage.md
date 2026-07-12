# Agent-Native Studio — Usage Guide

How to use Emberflow's coding-agent integration to edit flows, scenarios, and
nodes from inside the studio. For the design rationale and spike results, see
[2026-07-06-agent-native-studio-design.md](./2026-07-06-agent-native-studio-design.md).

## 1. What it is

Three entry points in the studio, each firing a different intent at the same
runner endpoints:

| Entry point | Where | Intent |
| --- | --- | --- |
| **Modify with AI** | Toolbar | `edit-flow` — free-form edit of the whole flow file |
| **New scenario with AI…** | Scenario dropdown (Run split button) | `new-scenario` — adds a scenario to the flow's `*.scenarios.json` |
| **Edit with AI** | Inspector header, when a node is selected | `edit-node` — edits one node within the flow file |

Each opens a one-line instruction input. Submitting it POSTs the intent to the
runner and opens the Agent Console to stream the run.

## 2. Requirements

- **A git repository.** The runner's `AgentRunManager.start()` checks
  `isGitRepo(projectDir)` before spawning anything and returns **400** ("`<dir>`
  is not a git repository") if it isn't. Diff + revert depend on git, so this
  is a hard precondition — run `git init` in the project first.
- **Codex and/or Claude Code on `PATH`.** `GET /agent/available` runs
  `codex --version` / `claude --version` (via `detectAgents()`) and returns
  whichever succeed. The Settings dialog's agent picker only lists detected
  agents; if neither is found it shows "No agent CLIs detected on PATH (looked
  for codex, claude)" and the entry points have nothing to run.
- **No credentials handled by Emberflow.** The runner shells out to your local
  `codex`/`claude` binary as a subprocess — it uses whatever auth/subscription
  that CLI already has configured on your machine. Emberflow never sees or
  stores API keys or session tokens.

## 3. How a run works

1. **Pick agent + model** in Settings (gear icon → "Coding agent" section).
   The choice (`agent`, optional `model` string, blank = CLI default) persists
   in `localStorage` (`emberflow.agentChoice`) and is used by default on every
   `runAgent` call.
2. **Trigger** from one of the three entry points and type a free-form
   instruction (e.g. "cover the empty-title case").
3. The store calls `POST /agent` with `{ intent, agent, model }`. The runner:
   - 409s if a run is already active for the project (one run at a time).
   - 400s if the project isn't a git repo, or the flow doesn't exist.
   - Otherwise snapshots the current git state, builds a skill-aware prompt
     (`buildPrompt` in `server/agents/prompt.ts` — always leads with "follow
     the installed emberflow-* skills, starting with emberflow-basics", then
     names the task, files, and the user's instruction verbatim), spawns the
     chosen adapter, and returns `{ agentRunId }`.
4. The studio opens the **Agent Console**, subscribed to
   `GET /agent/:id/events` (SSE, replays buffered events then streams live).
   It renders:
   - Reasoning prose as readable paragraphs (the point of the panel).
   - Consecutive shell commands collapsed into a single **"Ran N commands"**
     line, expandable to see each command, exit code, and output. A failed
     command auto-expands the group.
   - MCP/hook noise (Codex `error` *items* that are non-fatal diagnostics,
     e.g. an unauthenticated MCP server) is hidden behind a
     "N background diagnostics hidden" count instead of cluttering the stream.
5. On **done**: the store calls `syncFromRunner()` so the **canvas reloads
   live** — you see your instruction's effect immediately — then fetches
   `GET /agent/:id/diff` and shows it in the console with two actions:
   - **Revert** — `POST /agent/:id/revert`, restores files from the pre-run
     git snapshot, then reloads the canvas again.
   - **Dismiss** — hides the console without touching the run's changes
     (cancels the run first if it's still in progress).

## 4. Autonomy / sandbox model (per-agent)

The Phase 0 spike found Codex's `exec` mode has no mid-run interactive
approval — a sandboxed network call was silently blocked, not escalated. So
the two adapters use different but equivalent safety models, both **without**
ever using a bypass-everything flag:

- **Codex** (`server/agents/codexAdapter.ts`) spawns:
  ```
  codex exec -C <projectDir> -s workspace-write -c model_reasoning_effort=<low|medium|high> --json [-m <model>] <prompt>
  ```
  The **sandbox is the boundary**: `workspace-write` lets Codex edit files
  inside the project freely but blocks network access and out-of-workspace
  writes at the OS level, with no prompt to approve past it. Emberflow never
  passes `--dangerously-bypass-approvals-and-sandbox`. stdin is closed
  (`stdio: ['ignore', ...]`) so Codex doesn't hang waiting on it.
- **Claude** (`server/agents/claudeAdapter.ts`) spawns:
  ```
  claude -p <prompt> --output-format stream-json --verbose --permission-mode acceptEdits --add-dir <projectDir> [--model <model>]
  ```
  `--permission-mode acceptEdits` auto-accepts file edits — parity with
  Codex's workspace-write, just via a permission mode instead of a sandbox.
  The `AgentEvent` type still carries an `approval-request` variant for a true
  mid-run approve/deny over Claude's bidirectional stream-json — a documented
  future enhancement, not wired into this slice (Claude currently runs to
  completion the same way Codex does).

## 5. Apply model

This is **apply-then-diff-with-revert**, not a pre-approval gate: the agent
edits files directly during the run (that's what "workspace-write" /
"acceptEdits" mean), and you review the result afterwards:

1. `gitScope.snapshot()` records HEAD + dirty files right before spawn.
2. The agent edits files.
3. `GET /agent/:id/diff` returns `git diff` since the snapshot (or working-tree
   diff if there was no HEAD yet) plus the list of changed files.
4. `POST /agent/:id/revert` restores tracked files via
   `git checkout <snapshotHead> -- <files>` and deletes files that were newly
   created since the snapshot — so revert works even for a fresh repo with no
   commits (only the newly-added files get cleaned up in that case).

There is no approve-before-write step; the safety net is the git snapshot, not
a gate in front of the edit.

## 6. Safety notes

- The agent only ever operates inside the project directory it was spawned in
  (`-C <projectDir>` / `--add-dir <projectDir>`); it isn't given the rest of
  your filesystem.
- Secrets (`.env`, credentials) stay gitignored as normal — they aren't part
  of the git-scoped diff/revert and the runner doesn't read or forward them
  to the agent.
- The runner **requires** a git repo specifically so every run is revertable —
  this is enforced server-side (`AgentStartError`, HTTP 400), not left to the
  UI to remember.
- One run at a time per project (`AgentRunManager` tracks a single
  `activeRunId`); a second `POST /agent` while one is running gets a 409.
