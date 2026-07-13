import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InfrastructureManifest } from '../infrastructure';

/** Absolute path to the register-API CLI bin (`node <this> <cmd>`), resolved
 *  from this file's location. This exact invocation is the ONLY sandbox-safe
 *  way to run the CLI: `npx emberflow` / `tsx` spawn a tsx IPC pipe the codex
 *  sandbox blocks; this bin runs the CLI in-process under tsx's register API. */
const EMBERFLOW_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/emberflow.mjs');

export type AgentIntent =
  | { action: 'new-scenario'; flowId: string; instruction: string }
  | { action: 'edit-node'; flowId: string; nodeId: string; instruction: string }
  | { action: 'edit-flow'; flowId: string; instruction: string; scaffold?: boolean }
  | { action: 'new-operation'; location: string; instruction: string }
  | { action: 'setup-auth'; environment: string; instruction: string }
  | { action: 'setup-environments'; instruction: string }
  | { action: 'scout-infrastructure'; instruction: string }
  | { action: 'cover-operation'; flowId: string; instruction: string }
  | { action: 'ask'; flowId?: string; instruction: string };

/** Minimal node metadata the agent needs to know which node types it may build with. */
export interface AvailableNode {
  type: string;
  label?: string;
  description?: string;
}

/**
 * Builds a natural-language prompt for a coding agent (Codex/Claude) that
 * turns a studio `AgentIntent` into skill-aware instructions for editing
 * Emberflow flow files. Pure and deterministic: same inputs always produce
 * the same prompt string.
 *
 * `relPath` is the operation's on-disk relative path under `apisDir` (e.g.
 * `default/triage`) — NOT necessarily the same as `intent.flowId` (the
 * in-file `id`), since operations are keyed by id but stored by path. For
 * `new-operation` there is no existing flow yet, so `relPath` instead carries
 * the *resolved target directory* under `apisDir` (e.g. `billing` or
 * `default`) that the new operation file should be created inside.
 *
 * `availableNodes` is the full, consumer-specific set of registered node
 * types (domain nodes like `ValidateCredentials`/`FetchUser` plus built-ins
 * like `Input`/`Result`/`Response`/`requireAuth`). It is injected so the agent
 * knows what it can REUSE — but nodes are real code it can also author. The
 * prompt encourages inventing a node (registering its implementation) when no
 * existing one fits; the single guardrail is that a referenced `type` must be
 * registered in the same change, so a made-up type with no implementation
 * (e.g. a bare `CurrentServerTime`) can't slip through validation.
 *
 * `projectLanguage` is the target project's authored language (from its
 * `ProjectConfig.language`, explicit-or-inferred). Defaults to 'typescript' —
 * the Emberflow repo itself, when this function is called without a loaded
 * consumer project.
 *
 * `infrastructure` is the loaded `emberflow/infrastructure.json` manifest (or
 * `null` when the project hasn't been scouted / the file is malformed). When
 * present, a preamble block after the node palette lists what the project
 * already uses so the agent REUSES it (same secretRef names, same systems)
 * instead of inventing parallel config. The `scout-infrastructure` intent
 * itself is what WRITES this manifest, so it does not receive the block.
 */
export function buildPrompt(
  intent: AgentIntent,
  apisDir: string,
  relPath: string,
  availableNodes: AvailableNode[] = [],
  projectLanguage: 'javascript' | 'typescript' = 'typescript',
  infrastructure: InfrastructureManifest | null = null,
): string {
  const lines: string[] = [];

  /** Shared invariant for every flow-mutating intent: doctor is the mechanical
   *  checker (missing param defaults, uncovered path params, missing expects),
   *  so the per-intent prose no longer has to spell those rules out. */
  const doctorLine = (id: string) =>
    `Before finishing, run doctor ${id} and resolve its findings — fix warnings by editing the operation/scenarios (doctor --fix seeds missing param defaults), and mention any finding you deliberately leave in your final message.`;

  lines.push(
    'Skills available in this repo — read the one(s) relevant to your task; you do NOT need all of them (tap in as needed):',
  );
  lines.push(
    '- emberflow-basics — the project model: the apis/ file layout, how an operation and its optional http trigger work, nodes, scenarios, auth. Read first if unsure how the project is structured.',
  );
  lines.push('- emberflow-new-workflow — building a new operation: choosing the trigger and wiring Input → logic → terminus.');
  lines.push('- emberflow-review-workflow — a rubric to self-check an operation before calling it done (wiring, branches, terminus, auth).');
  lines.push('- emberflow-model-process — porting an existing real process/endpoint into an operation faithfully.');
  lines.push('');
  lines.push(
    'Nodes are real code you WRITE, not a fixed menu. When the goal needs a capability no existing node provides — calling an external API (e.g. an HTTP fetch), a custom transform, a domain rule — CREATE a new node: add its definition plus an implementation `async (ctx) => output` to the project by calling `registry.register(definition, implementation)` inside `registerNodes(registry)` in the project\'s `emberflow.config.(mjs|js|ts)` (or a nodes module that file imports), then reference its `type` from the operation. Inventing nodes is normal and encouraged — build the operation out with as many nodes as the goal genuinely needs (an HTTP call → parse → shape → respond is four nodes, not two).',
  );
  lines.push('');
  lines.push(
    'The one hard rule: NEVER reference a node `type` you have not registered. A made-up type with no implementation fails flow validation. So whenever you use a new type, you MUST register its implementation in the SAME change. Reuse an existing registered node only when it genuinely fits; otherwise author the node you need.',
  );
  lines.push('');
  lines.push(
    projectLanguage === 'javascript'
      ? 'This project is javascript-driven: author nodes, config edits, and any new modules in JavaScript (.mjs/.js, JSDoc types) — do not introduce TypeScript files into it.'
      : 'This project is typescript-driven: author nodes, config edits, and any new modules in TypeScript (.ts, typed) — do not introduce JavaScript files into it.',
  );
  lines.push('');
  const traceKindLine =
    'When you register a new node\'s implementation, set its traceKind honestly: `"db"`, `"http"`, or `"llm"` for anything that touches real infrastructure (a database, an external API/network call, a model call), omitted (or `"compute"`) for pure logic that only transforms its input. `traceKind` is the mock-mode infrastructure boundary — in a mock run, compute nodes execute for real but infra nodes require a canned output (see the mocks guidance for scenario-authoring tasks); a node that touches infrastructure but is left without a `traceKind` will silently execute for real during a mock run instead of being caught, so get this right when you author the node.' +
    ' For mutation nodes (effects: "mutation"): the commit path (config.commit === true && !ctx.safeMode) performs the REAL side effect — these are operational APIs, and a commit branch that logs "[SIMULATED]" and returns success is FORBIDDEN. Mock mode and dry-run already cover design-time needs; if a required secret is missing at commit time, THROW an error naming the exact secretRef the user must set (studio Manage Environment dialog) — never fake success. doctor flags fake commits as simulated-commit.';
  lines.push('Existing registered node types you can reuse before authoring a new one:');
  if (availableNodes.length === 0) {
    lines.push('(none reported yet — author the nodes the goal needs, registering each in registerNodes.)');
  } else {
    for (const node of availableNodes) {
      const bits = [node.type];
      if (node.label) bits.push(`label: ${node.label}`);
      if (node.description) bits.push(`description: ${node.description}`);
      lines.push(`- ${bits.join(' — ')}`);
    }
  }
  lines.push('');

  // Known-infrastructure preamble: what the project already uses, so the agent
  // REUSES it instead of inventing parallel config. Omitted for the scout
  // intent — it's the one that WRITES the manifest, so priming it with the
  // manifest's own contents would be circular.
  if (intent.action !== 'scout-infrastructure') {
    const INFRASTRUCTURE_ITEM_CAP = 30;
    if (infrastructure && infrastructure.items.length > 0) {
      lines.push('Known project infrastructure (from emberflow/infrastructure.json — what this project already uses):');
      const shown = infrastructure.items.slice(0, INFRASTRUCTURE_ITEM_CAP);
      for (const item of shown) {
        const bits = [`${item.name} (${item.kind})`];
        if (item.suggestedSecretRefs.length > 0) bits.push(`secretRefs: ${item.suggestedSecretRefs.join(', ')}`);
        const firstEvidence = item.evidence.find((e) => e.file)?.file;
        if (firstEvidence) bits.push(`see ${firstEvidence}`);
        lines.push(`- ${bits.join(' — ')}`);
      }
      const remaining = infrastructure.items.length - shown.length;
      if (remaining > 0) {
        lines.push(`(+${remaining} more — see emberflow/infrastructure.json or re-run the scout)`);
      }
      lines.push(
        'REUSE rule: when an operation needs infrastructure this manifest already names, REUSE it — the same secretRef NAMES, the same systems (database, API, provider) — instead of inventing parallel config. When the manifest is absent or looks stale relative to what you find, SAY so rather than guessing.',
      );
      lines.push('');
    } else if (infrastructure && infrastructure.greenfield) {
      lines.push(
        'Known project infrastructure: emberflow/infrastructure.json marks this project greenfield (no existing databases/APIs/providers detected). Introduce infrastructure only as the goal genuinely requires it.',
      );
      lines.push('');
    } else if (infrastructure) {
      // Present but empty, and NOT greenfield: distinct from "no manifest at
      // all" — the scout ran and found nothing, which may mean the project
      // grew since the last scan rather than genuinely having no infra.
      lines.push(
        'Known project infrastructure: the infrastructure manifest exists but lists no items — re-run the scout if the project has grown.',
      );
      lines.push('');
    } else {
      lines.push(
        'Known project infrastructure: none on record (no emberflow/infrastructure.json manifest). If this operation needs to reuse existing databases/APIs/providers, consider running the infrastructure scout first rather than guessing what the project already uses.',
      );
      lines.push('');
    }
  }

  lines.push(
    `You control the live runner (the studio canvas) through the Emberflow CLI. Make EDITS by writing files; use the CLI to RUN, INSPECT, and REMOVE. Invoke it EXACTLY like this (a shell command) — this precise form is required, because \`npx emberflow\` and \`tsx\` fail inside this sandbox:`,
  );
  lines.push(`  node ${EMBERFLOW_BIN} <command> [args]`);
  lines.push('Commands (each talks to the already-running runner):');
  lines.push('- run <id> [--input \'<json>\' | --scenario <name>] [--env <name>] [--full] — run an operation and print its status, per-node nodeStates, and logs. Output is CONCISE by default (large node inputs/outputs are truncated to keys + a preview, so a flow whose fetch node returns 70KB of raw API JSON stays readable); add --full only when you need a node\'s complete raw output. Use to VERIFY a change, then report the result.');
  lines.push('- get-workflow <id> — print an operation\'s full JSON. Use to inspect what exists.');
  lines.push('- get-node <id> <nodeId> — print ONE node\'s wiring: its config/inputMap/retry/optional, its inbound + outbound edges, and (when the type is registered) a definition summary (input/output field names, its trace kind and effects). Use to zoom into a single node without reading the whole operation JSON.');
  lines.push('- list-workflows — list all operations (id, name, path, http).');
  lines.push('- node-schema <type> — one node\'s exact input/output contract. The registered nodes are ALREADY listed above with descriptions, and the best way to learn how to WIRE a node is to read an operation that already uses it (get-workflow — it shows the node in context with real config + edges). Reach for node-schema only when you need a node\'s precise field names and no existing operation demonstrates them; don\'t look nodes up one-by-one out of habit. (list-nodes also exists but you rarely need it — the palette is above.)');
  lines.push('- list-environments — the configured environments (names, which are protected).');
  lines.push('- login-environment <name> — perform the environment\'s configured login and store its credential runner-side; run this if operations fail 401/unauthorized and list-environments shows auth configured but not authenticated.');
  lines.push('- set-environment-auth <name> --json \'<EnvAuth JSON>\' — set (or, with --json \'null\', clear) an environment\'s auth block; carries no secret values, only refs/names.');
  lines.push('- delete <id> — remove an operation.');
  lines.push('- test <id> — run the operation\'s scenario expectations in-process; exit 0/1.');
  lines.push('- doctor [<id>] [--fix] — report operation diagnostics (missing param defaults, uncovered path params, missing expects); --fix auto-seeds missing param defaults. Run it on any operation you created or edited and resolve every finding before you finish.');
  lines.push('- serving <real|mock> — switch whether mounted HTTP endpoints execute for real or answer from scenario expectations (mock). NEVER switch this yourself: the mode is the user\'s choice, and flipping it mid-task makes their runs hit real infrastructure without them knowing. In mock mode, `run <id>` executes against scenario mocks and `test <id>` always runs hermetically — verify with those; if your verification truly needs a real run, say so in your final message instead of flipping the mode.');
  lines.push('- rename <old-id> <new-id> [--name "<display>"] — rename an operation: moves it to the new apis path/id AND updates its display name + http route to match. Operations often start with a vague auto-generated name derived from the create prompt (e.g. "api-which-uses-different", "another-api-call-like"). NAMING IS PART OF YOUR JOB: before finishing, if the id or display name does not clearly say what the operation does, rename it to a concise descriptive slug (e.g. "world-cup-recent-results").');
  lines.push(
    'Rule of thumb: edits = files; actions (run, read logs, inspect, delete) = the CLI above. These CLI calls are surfaced as distinct operation steps in the Agent view.',
  );
  lines.push(
    'INSPECTION ORDER: to understand or locate something, go top-down through the CLI BEFORE opening files — list-workflows (find the op) → get-workflow <id> (see the graph) → get-node <id> <nodeId> (one node\'s wiring) → node-schema <type> (the registered definition) → samples <nodeId> (recorded runs). Open source files directly only once the CLI has told you WHERE to look (e.g. a node implementation you located by type).',
  );
  lines.push('');
  lines.push(
    'AUTH: environments may carry an auth block (attach cookie/header + optional login request + capture) in emberflow.environments.json. Studio/CLI runs auto-attach the stored credential. You NEVER see secret values — they appear as «secret:KEY» in run output. When asked to set up auth for an environment, scaffold the auth block in emberflow.environments.json (attach.name = the cookie/header the API expects, secretRef naming where the captured credential lands, login.request with bodyRef pointing at a secret holding the credentials JSON) and then run login-environment <name> to verify capture works.',
  );
  lines.push(
    'Reading an existing operation is your PRIMARY way to understand how nodes are used — the workflow JSON already contains the nodes, their config, and the edges wired together. When your goal is "like operation X but …", or the same nodes appear in a sibling op, READ that operation first (get-workflow <id>, or the .json under the apis directory) and mirror its structure — that\'s faster and more reliable than inspecting nodes one at a time. Reading any operation is never restricted; only EDITING is scoped to your task.',
  );
  lines.push('');
  lines.push(
    `TEST AS YOU BUILD — do not wait until the end. Every time you add or change nodes (or a node's implementation), run the operation (\`node ${EMBERFLOW_BIN} run <id> --input '<json>'\`, or with --scenario) and READ the printed nodeStates + logs: each node's input, output, and status is in nodeStates, so you can see exactly which node misbehaves — not just the final Response. That IS your isolation — inspect the specific node's entry rather than guessing from the graph. When a node errors or returns the wrong value, fix its implementation or wiring and run again. Iterate — run, read, fix, re-run — until the operation runs correctly end-to-end. A flow that VALIDATES is not necessarily a flow that WORKS; running it is how you find out.`,
  );
  lines.push(
    `Once it runs correctly, ALSO make sure it stays correct: for every path you changed, add or update a scenario in the op's scenarios sidecar file with an "expect" ({status?, body?, executedNodes?} — assert at minimum status and the branch's terminal node id) so the behavior is asserted, not just eyeballed. Finish with \`node ${EMBERFLOW_BIN} test <id>\` — exit 0 means done; a failure means the scenario or the flow is still wrong, so keep iterating (run/read nodeStates to debug which node is at fault, fix, re-run test) until it passes.`,
  );
  lines.push('');

  /** Shared guidance for scenario-authoring intents (new-scenario, cover-operation):
   *  scenarios must carry canned output for any infrastructure node they exercise,
   *  in the exact op-level ⊕ per-scenario `mocks` shape the mock-run engine reads. */
  const mocksLine = (scenariosFile: string) =>
    `Mock runs: a node whose registered definition sets \`traceKind\` to "db", "http", or "llm" touches real infrastructure, so a mock run of any scenario reaching it needs a canned output for it or it fails. For every such infrastructure node your scenario(s) reach, add a "mocks" entry — { nodeId: output } — giving that node a REALISTIC canned output matching the exact shape its implementation returns (read the node's implementation in emberflow.config.(mjs|js|ts) or the nodes module it imports to learn that shape; a mocks value is the node's OUTPUT verbatim, not a wrapper around it). ${scenariosFile} carries two levels: a top-level "mocks" map (the op-level default, used by a plain Run with no scenario selected) and, inside each entry under "scenarios", an optional per-scenario "mocks" map that overrides the op-level default per nodeId for that scenario only. Author BOTH: the op-level "mocks" so plain Run works, and any per-scenario "mocks" a specific scenario needs to diverge (e.g. an error-path scenario mocking a lookup node to return "not found"). NEVER put secret values in a mocks entry — mocked output must not contain real credentials, tokens, or other secret material, even fake-looking ones that resemble real formats.`;

  switch (intent.action) {
    case 'new-scenario': {
      const flowFile = join(apisDir, ...relPath.split('/')) + '.json';
      const scenariosFile = join(apisDir, ...relPath.split('/')) + '.scenarios.json';
      lines.push(`Relevant skill: emberflow-basics (the scenario shape).`);
      lines.push('');
      lines.push(
        `Task: add a new scenario to the flow "${intent.flowId}". The flow definition lives at ${flowFile} and its scenarios live at ${scenariosFile}.`,
      );
      lines.push('');
      lines.push(`User instruction (verbatim): ${intent.instruction}`);
      lines.push('');
      lines.push(
        `Give the scenario an "expect" ({status?, body?, executedNodes?}) so it doubles as a test, not just a named input — at minimum assert status and the branch's terminal node id in executedNodes; add a body subset to expect wherever the response is deterministic.`,
      );
      lines.push('');
      lines.push(mocksLine(scenariosFile));
      lines.push('');
      lines.push(
        `Only edit ${flowFile} and ${scenariosFile}. Keep both files valid JSON, and validate that the flow's wiring (node connections and references) remains correct.`,
      );
      lines.push('');
      lines.push(
        `Verify with \`node ${EMBERFLOW_BIN} test ${intent.flowId}\` — don't stop at just running the scenario; the test command asserts the expect and exits 0/1, so a passing test is proof the scenario actually checks what it claims.`,
      );
      lines.push('');
      lines.push(doctorLine(intent.flowId));
      break;
    }
    case 'edit-node': {
      const flowFile = join(apisDir, ...relPath.split('/')) + '.json';
      lines.push(`Relevant skill: emberflow-basics (node + config shape).`);
      lines.push('');
      lines.push(
        `Task: edit node "${intent.nodeId}" in the flow "${intent.flowId}". The flow definition lives at ${flowFile}.`,
      );
      lines.push('');
      lines.push(`User instruction (verbatim): ${intent.instruction}`);
      lines.push('');
      lines.push(
        `Only edit ${flowFile}. Keep the file valid JSON, and validate that the flow's wiring (node connections and references) remains correct.`,
      );
      lines.push('');
      lines.push(doctorLine(intent.flowId));
      break;
    }
    case 'edit-flow': {
      const flowFile = join(apisDir, ...relPath.split('/')) + '.json';
      if (intent.scaffold) {
        // Studio "create" path: the op is a freshly-scaffolded Input → Response
        // shell whose name is a PLACEHOLDER derived from the create prompt
        // (e.g. "Similar Api Call Will"). Naming + building are the whole job.
        lines.push(`Relevant skills: emberflow-new-workflow (building it out), emberflow-review-workflow (self-check).`);
        lines.push('');
        lines.push(`This operation was just scaffolded as an empty Input → Response shell. Its current id/name ("${intent.flowId}") is an auto-generated PLACEHOLDER from the create prompt, not a real name. The flow definition lives at ${flowFile}.`);
        lines.push('');
        lines.push(`User goal (verbatim): ${intent.instruction}`);
        lines.push('');
        lines.push('Do it in this order:');
        lines.push(
          `1. NAME IT FIRST. Pick a clear, descriptive kebab-case id + display name that say what the operation does, and rename the shell before building: node ${EMBERFLOW_BIN} rename ${intent.flowId} <new-id> --name "<Display Name>". This updates the id, the display name, and the http route together. (Keep the id in the same folder unless the goal implies otherwise.)`,
        );
        lines.push(
          `2. BUILD IT OUT by editing the renamed file — add the logic nodes the goal needs between Input and the Response terminus. If it needs a node type that isn't registered yet, ALSO author it: add its implementation via registry.register(definition, impl) inside registerNodes(registry) in the project's emberflow.config.(mjs|js|ts) (or a nodes module it imports). Keep every referenced node type registered. ${traceKindLine}`,
        );
        lines.push(
          `3. RUN + VERIFY: node ${EMBERFLOW_BIN} run <new-id> — read the nodeStates and iterate until it produces the right result. Self-check with emberflow-review-workflow.`,
        );
        lines.push('');
        lines.push(doctorLine('<new-id>'));
        break;
      }
      lines.push(`Relevant skills: emberflow-basics (the existing operation's shape), emberflow-review-workflow (self-check). This is about an EXISTING operation — do NOT treat it as building a new one.`);
      lines.push('');
      lines.push(`Task: the user's message below concerns the flow "${intent.flowId}". The flow definition lives at ${flowFile}.`);
      lines.push('');
      lines.push(`User instruction (verbatim): ${intent.instruction}`);
      lines.push('');
      lines.push(
        `FIRST decide what the message is. If it is a QUESTION or a request to explain/locate something ("where is…", "why does…", "what happens when…"), ANSWER it and change NOTHING — no file writes, no create/save/delete, no doctor --fix; use the INSPECTION ORDER above (CLI before file reads), lead with the direct answer in 1-3 sentences, then supporting detail with file:line references, and stop there. Only when the message asks for a CHANGE do the edit instructions below apply. If it genuinely could be either, say what you would change and ask one clarifying question instead of editing.`,
      );
      lines.push('');
      lines.push(
        `After making changes, self-check your work using emberflow-review-workflow.`,
      );
      lines.push('');
      lines.push(
        `Edit ${flowFile} to make the change, building the operation out with as many nodes as the goal genuinely needs. If it needs a node type that isn't registered yet, ALSO author that node: add its implementation via registry.register(definition, impl) inside registerNodes(registry) in the project's emberflow.config.(mjs|js|ts) (or a nodes module that file imports). Keep every file you touch valid, and validate that the flow's wiring (node connections and references) stays correct — every referenced node type must be registered. ${traceKindLine} Before you consider it done, RUN it (node <bin> run <id>), read the nodeStates, and iterate until it produces the right result.`,
      );
      lines.push('');
      lines.push(doctorLine(intent.flowId));
      break;
    }
    case 'new-operation': {
      const targetDir = join(apisDir, ...relPath.split('/'));
      lines.push(`Relevant skills: emberflow-new-workflow, emberflow-review-workflow.`);
      lines.push('');
      lines.push(
        `Task: create a brand-new operation that achieves the user's goal below. The operation does not exist yet — you are creating it from scratch inside ${targetDir}.`,
      );
      lines.push('');
      lines.push(`User goal (verbatim): ${intent.instruction}`);
      lines.push('');
      lines.push(
        `Choose a clear, descriptive kebab-case filename for the new operation and create it at ${targetDir}/<name>.json. Set the file's in-file "id" field equal to its path relative to the apis directory (for example, if you create ${targetDir}/charge.json, its "id" must be "${relPath}/charge" — do not invent a different id).`,
      );
      lines.push('');
      lines.push(
        `Decide the operation's shape from the goal — don't assume it's an HTTP endpoint. An operation always starts with an "Input" entry node and runs whatever logic nodes the goal needs; the trigger + terminus depend on what it is:`,
      );
      lines.push(
        `  • An HTTP endpoint (something is called over the web): add an "http" trigger — { method, path } that fit the goal (you choose the mechanics) — Input receives the request as { params, query, body, headers }, and the flow ends in a "Response" node emitting { status, body }.`,
      );
      lines.push(
        `  • An internal sub-flow (called by other operations via a Subflow node, or run in the studio): OMIT "http" and end in "Result" node(s).`,
      );
      lines.push(
        `Pick whichever fits the goal, and build it out with as many nodes as the goal genuinely needs.`,
      );
      lines.push('');
      lines.push('Do it in this order:');
      lines.push(
        `1. NAME + CREATE THE SHELL FIRST. Decide a clear, descriptive kebab-case id under "${relPath}" (e.g. ${relPath}/<descriptive-slug>), a human display name, and — for an HTTP endpoint — the method (GET to read, POST to create, PATCH/PUT to update, DELETE to remove) and the route path. Then create the shell with the CLI:`,
      );
      lines.push(`     node ${EMBERFLOW_BIN} create <id> --method <METHOD> --path </route> --name "<Display Name>"   (HTTP endpoint)`);
      lines.push(`     node ${EMBERFLOW_BIN} create <id> --name "<Display Name>"                                       (internal sub-flow — no method/path; ends in Result)`);
      lines.push(`   This writes a valid shell (Input → Response/Result + the trigger). Do this BEFORE building any logic.`);
      lines.push(
        `2. BUILD IT OUT by editing the created file at ${targetDir}/<id>.json — add the logic nodes the goal needs between Input and the terminus. If the goal needs a node type that isn't registered yet, ALSO author it: add its implementation via registry.register(definition, impl) inside registerNodes(registry) in the project's emberflow.config.(mjs|js|ts) (or a nodes module that file imports). Don't modify files unrelated to this operation and its nodes. ${traceKindLine}`,
      );
      lines.push(
        `3. RUN + VERIFY: node ${EMBERFLOW_BIN} run <id> — read the nodeStates, and iterate until it produces the right result.`,
      );
      lines.push('');
      lines.push(doctorLine('<id>'));
      lines.push('');
      lines.push(
        `ENVIRONMENTS + SECRETS INTAKE: if the operation touches infrastructure (a database, an external API, an LLM), check whether emberflow.environments.json covers what it needs. Where it doesn't, do NOT invent values: reference clearly-named secretRef keys (ctx.secrets.<KEY>) and vars (ctx.vars.<NAME>) in the node implementations, list those secret key NAMES (values never) under the relevant environment's "secrets" list in emberflow.environments.json, author the sidecar mocks so the operation is fully runnable in mock mode regardless, and END your final message by asking the user the specific open questions — which environments this should run against, which is production-like, and telling them to enter the secret values for the keys you named via the studio's Manage Environment dialog (never in this chat).`,
      );
      break;
    }
    case 'setup-auth': {
      lines.push(`Relevant skill: emberflow-basics (the auth block shape). See the AUTH guidance above for the block's shape and CLI commands — this task is that guidance applied to one environment.`);
      lines.push('');
      lines.push(
        `Task: get a working "auth" block for environment "${intent.environment}" from the description below (curl command, prose, or both).`,
      );
      lines.push('');
      lines.push(`User instruction (verbatim): ${intent.instruction}`);
      lines.push('');
      lines.push(
        `Inspect the target API's login from the instruction, then compose the EnvAuth JSON: attach (as: "cookie"|"header", name, secretRef, and prefix for schemes like "Bearer " or "Basic ") plus an optional login (request + capture). Use prefix for Bearer/Basic-style headers; use bodyRef when the login request body itself must carry a credential (a secret holding the request body JSON, not inline values). Apply it with: set-environment-auth ${intent.environment} --json '<EnvAuth JSON>'.`,
      );
      lines.push('');
      lines.push(
        `NEVER read or edit emberflow.environments.json directly — set-environment-auth is the only way to change this environment's auth. NEVER ask for or handle credential values — the user enters secret values themselves in the studio's Manage Environment dialog, never through you. If applying the auth block requires a secret that isn't set yet (a bodyRef for the login body, or the attach.secretRef for a static key with no login), name EXACTLY which key the user must fill in in the Manage Environment dialog, then STOP — do not guess, invent, or ask the user to paste a value into chat.`,
      );
      lines.push('');
      lines.push(
        `If the secrets the auth block needs are already present, verify the setup with: login-environment ${intent.environment}. If capture fails, read the error, adjust the auth JSON (e.g. the capture path/cookie name), re-apply with set-environment-auth, and retry — iterate until login-environment succeeds or you hit a missing-secret stop condition above.`,
      );
      lines.push('');
      lines.push(
        `Finish by running list-environments and reporting this environment's auth state (configured/authenticated) from its output.`,
      );
      break;
    }
    case 'setup-environments': {
      lines.push(`Relevant skill: emberflow-basics (environments + auth). See the AUTH guidance above for the auth block's shape.`);
      lines.push('');
      lines.push(`Task: the user wants to set up the project's environments; their description follows.`);
      lines.push('');
      lines.push(`User instruction (verbatim): ${intent.instruction}`);
      lines.push('');
      lines.push(
        `Read emberflow.environments.json at the project root if it exists; create it (alongside emberflow.config.*) if it does not. This file is STRUCTURE ONLY and safe for you to edit: create or extend "defaultEnvironment" plus one entry under "environments" per environment the user described, using kebab/lower-case names (e.g. "dev", "staging", "prod"). Each environment's "secrets" is a LIST of key NAMES (e.g. "secrets": ["API_KEY"]) — never a value map. Secret VALUES live in emberflow.secrets.json (chmod 0600), which you never read or write; the user fills those in via the Manage Environment dialog.`,
      );
      lines.push('');
      lines.push(
        `Work from the user's description ALONE. This is a config-writing task, not an investigation: do NOT explore the project's source code, node implementations, other repositories, deployment providers, or any MCP/external service to infer URLs, hostnames or settings the user didn't state. Where the user's description leaves a value unknown, write a clearly-named placeholder var (e.g. "baseUrl": "https://CHANGE-ME.example.com") and list it as an open item in your final message instead of hunting for it.`,
      );
      lines.push('');
      lines.push(
        `Mark production-like environments "protected": true — this forces studio safe mode for runs against them and blocks serving them by default, so mistakes there are costly and Emberflow guards them harder. Put base URLs and other non-secret config under each environment's "vars".`,
      );
      lines.push('');
      lines.push(
        `NEVER invent or write secret or credential VALUES anywhere — not in emberflow.environments.json (which holds only key NAMES), not in emberflow.secrets.json (the 0600 values file you never touch), and not in your output. Where auth or API keys are involved, scaffold at most the secret key NAMES in an environment's "secrets" list and an "auth" block containing secretRef NAMES (no values) — and in your final message, tell the user to add the actual secret values via the studio's per-environment Manage Environment dialog, or by running login-environment <env> for auth that captures a credential through a login flow.`,
      );
      lines.push('');
      lines.push(`emberflow.environments.json is gitignored — mention this in your final message so the user isn't surprised it doesn't show up in git status.`);
      lines.push('');
      lines.push(
        `Finish by summarizing, for each environment you created or extended: its name, whether it's protected, and what (if anything) the user still needs to fill in (e.g. "dev: needs no secrets" / "prod: needs the API_KEY secret value in Manage Environment").`,
      );
      lines.push('');
      lines.push(
        `This panel is a conversation: when the user's description leaves a load-bearing choice genuinely open — which environment is the default, which are production-like (protected), what an environment's base URL is — END your final message with those specific questions (numbered, one line each) so the user can answer in their next message. Ask about real gaps only; don't quiz them on things you could reasonably default and have clearly listed as placeholders.`,
      );
      break;
    }
    case 'scout-infrastructure': {
      const manifestPath = 'emberflow/infrastructure.json';
      lines.push(`Relevant skill: emberflow-basics (the project model + file layout).`);
      lines.push('');
      lines.push(
        `Task: scout this project's existing infrastructure and write a manifest describing it. Your JOB for THIS intent is to READ the project — this deliberately INVERTS the "do NOT explore the project's source code" rule that constrains setup-environments; for scout-infrastructure, exploring the codebase IS the work.`,
      );
      lines.push('');
      if (intent.instruction.trim()) {
        lines.push(`User instruction (verbatim): ${intent.instruction}`);
        lines.push('');
      }
      lines.push(
        `AMENDMENT vs FULL RESCAN: if the instruction above asks for an amendment to the existing manifest — add, remove, or correct SPECIFIC items — and emberflow/infrastructure.json already exists, UPDATE that file in place: preserve every item you were not asked to change, apply only the requested change, and bump "scannedAt" to the current timestamp. Do NOT regenerate the whole manifest from scratch for a targeted amendment. A FULL RESCAN (rebuild the manifest from the whole project) remains the default when the instruction is empty or asks to re-scan/refresh generally.`,
      );
      lines.push('');
      lines.push(
        `Investigate broadly — enumerate what the project already depends on and talks to:`,
      );
      lines.push(
        `  • Dependencies: package.json + lockfiles, requirements.txt / pyproject.toml, go.mod, Gemfile, composer.json, etc.`,
      );
      lines.push(`  • Config files: docker-compose.yml, Dockerfile, .env.example / .env.sample (NAMES only), prisma/schema.prisma, ORM configs, framework config.`);
      lines.push(`  • ORM schemas / migrations: the models and tables the project defines.`);
      lines.push(`  • Env-var REFERENCES in source (process.env.X, os.environ["X"], import.meta.env.X, ${'${VAR}'} in compose) — capture the NAMES.`);
      lines.push(`  • HTTP clients / SDK usage: fetch/axios/requests calls, vendor SDKs (stripe, sendgrid, aws-sdk, openai, twilio, …).`);
      lines.push(`  • Existing route/endpoint definitions: the app's own HTTP surface (Express routers, FastAPI routes, etc.).`);
      lines.push('');
      lines.push(
        `Classify each thing you find into one of these manifest kinds: database, http-api, queue, cache, email, llm, auth, framework, storage, other. Pick the closest kind; use "other" only when nothing fits.`,
      );
      lines.push('');
      lines.push(
        `WRITE the manifest to ${manifestPath} (create the emberflow/ directory if it doesn't exist). Pretty-printed JSON, this exact shape:`,
      );
      lines.push(
        `  { "version": 1, "scannedAt": "<current ISO timestamp>", "greenfield": <bool>, "summary": "<one sentence>", "items": [ { "id": "<kebab-slug>", "kind": "<kind>", "name": "<human name>", "evidence": [ { "file": "<path>", "note": "<what proves it>" } ], "suggestedSecretRefs": ["<ENV_VAR_NAME>"], "suggestedVars": [], "notes": "<optional>" } ] }`,
      );
      lines.push('');
      lines.push(
        `HARD RULE — NEVER copy a secret VALUE into the manifest. suggestedSecretRefs holds env-var NAMES ONLY (e.g. "DATABASE_URL", "STRIPE_SECRET_KEY") — never the value behind the name, even if you happen to see it in a .env file. Evidence points at FILES (with a short note), never at credential contents.`,
      );
      lines.push('');
      lines.push(
        `Each item's "evidence" should point at the real file(s) that prove it (e.g. "package.json" for a dependency, "prisma/schema.prisma" for a database) with a short note, so the studio can show provenance and other agents can jump straight to the source. Give each item a stable kebab-case "id" and a human-readable "name".`,
      );
      lines.push('');
      lines.push(
        `GREENFIELD: if this project has essentially no infrastructure yet (a bare scaffold — no databases, external APIs, or providers), set "greenfield": true, leave "items" empty, and write a one-line summary saying so. Don't invent items to fill space.`,
      );
      lines.push('');
      lines.push(
        `Reminder (stated twice on purpose): the manifest is COMMITTED and contains NO secret values — only names, files, and notes. Double-check every suggestedSecretRefs entry and every note before you finish: if any of them is an actual secret value rather than a NAME, remove it.`,
      );
      lines.push('');
      lines.push(
        `Finish with a short summary of what you found (grouped by kind) PLUS an "open questions" list: anything you couldn't confidently classify, or that looks like infrastructure but you weren't sure about — so the user can confirm or correct it.`,
      );
      break;
    }
    case 'cover-operation': {
      const flowFile = join(apisDir, ...relPath.split('/')) + '.json';
      const scenariosFile = join(apisDir, ...relPath.split('/')) + '.scenarios.json';
      lines.push(`Relevant skill: emberflow-basics (the scenario shape).`);
      lines.push('');
      lines.push(
        `Task: build a branch-covering scenario suite for the operation "${intent.flowId}". The flow definition lives at ${flowFile} and its scenarios live at ${scenariosFile} (create it if it doesn't exist yet).`,
      );
      lines.push('');
      lines.push(`User instruction (verbatim): ${intent.instruction}`);
      lines.push('');
      lines.push(
        `Read ${flowFile} and identify every Route/Conditional branch and every terminal Response/Result node the operation can reach. For each branch, write or extend a scenario in ${scenariosFile} that drives execution down that branch, with an "expect" that at minimum asserts status and executedNodes (the branch's terminal node id) — add a body subset to expect wherever the response is deterministic.`,
      );
      lines.push('');
      lines.push(
        `Use a real id from the project's data when you can obtain one (e.g. by reading a data file or calling a lookup operation); otherwise a clearly-fake but well-formed placeholder (e.g. "test-id-1").`,
      );
      lines.push('');
      lines.push(mocksLine(scenariosFile));
      lines.push('');
      lines.push(
        `NEVER weaken or delete an existing expect to make the suite pass. If an existing expectation looks wrong, leave it as-is, make your new scenarios pass on their own merits, and report the discrepancy in your final message instead of touching it.`,
      );
      lines.push('');
      lines.push(
        `Verify with: node ${EMBERFLOW_BIN} test ${intent.flowId} — iterate (adjust the new scenarios, re-run) until every new scenario passes. Finish by reporting the suite summary (passed/failed/skipped) from the final test run.`,
      );
      lines.push('');
      lines.push(doctorLine(intent.flowId));
      break;
    }
    case 'ask': {
      lines.push('Relevant skill: emberflow-basics (how the project is structured) — read it only if answering needs it.');
      lines.push('');
      if (intent.flowId) {
        const flowFile = join(apisDir, ...relPath.split('/')) + '.json';
        lines.push(`This is a question about the operation "${intent.flowId}". Its definition lives at ${flowFile}.`);
      } else {
        lines.push('This is a question about this Emberflow project as a whole.');
      }
      lines.push('');
      lines.push(`User question (verbatim): ${intent.instruction}`);
      lines.push('');
      lines.push(
        'This is a QUESTION, not an edit — ANSWER it and change NOTHING. Do NOT write, create, save, edit, delete, or rename any file or operation; do NOT run doctor --fix; do NOT switch serving mode. Running READ-ONLY CLI commands (list-workflows, get-workflow, get-node, node-schema, samples, list-environments, and mock/test runs) and reading files is exactly how you investigate — that is fine and encouraged. Follow the INSPECTION ORDER above: reach through the CLI top-down before opening source files.',
      );
      lines.push('');
      lines.push(
        'Answer format: LEAD with the direct answer in 1-3 sentences, then supporting detail with file:line references where they help. Keep it tight — plain prose and short lists (the panel renders simple markdown: bold, inline code, lists). Do NOT restate the question or pad with summaries the user did not ask for.',
      );
      break;
    }
    default: {
      const action = (intent as { action: string }).action;
      throw new Error('Unknown intent action: ' + action);
    }
  }

  return lines.join('\n');
}
