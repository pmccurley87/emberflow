import { describe, expect, it } from 'vitest';
import { buildPrompt, type AgentIntent } from './prompt';

describe('buildPrompt', () => {
  const apisDir = 'flows';
  const relPath = 'hello';

  it('new-scenario: names the flow file and scenarios file, includes instruction verbatim and a skill reference', () => {
    const intent: AgentIntent = {
      action: 'new-scenario',
      flowId: 'hello',
      instruction: 'Add a scenario where the user says "hi" and the bot replies "hello back".',
    };

    const prompt = buildPrompt(intent, apisDir, relPath);

    expect(prompt).toContain(intent.instruction);
    expect(prompt).toContain('flows/hello.json');
    expect(prompt).toContain('flows/hello.scenarios.json');
    expect(prompt).toMatch(/emberflow-/);
    expect(prompt).toMatch(/only edit/i);
    expect(prompt).toMatch(/expect/i);
    expect(prompt).toMatch(/executedNodes/);
    expect(prompt).toMatch(/test hello/);
  });

  it('edit-node: names the flow file, the node id, includes instruction verbatim and a skill reference', () => {
    const intent: AgentIntent = {
      action: 'edit-node',
      flowId: 'hello',
      nodeId: 'greet-node',
      instruction: 'Make the greeting node use a friendlier tone.',
    };

    const prompt = buildPrompt(intent, apisDir, relPath);

    expect(prompt).toContain(intent.instruction);
    expect(prompt).toContain('flows/hello.json');
    expect(prompt).toContain('greet-node');
    expect(prompt).toMatch(/emberflow-/);
    expect(prompt).toMatch(/only edit/i);
  });

  it('edit-flow: names the flow file, includes instruction verbatim, a skill reference, and mentions self-review', () => {
    const intent: AgentIntent = {
      action: 'edit-flow',
      flowId: 'hello',
      instruction: 'Rewire the flow so the fallback node runs before the closing node.',
    };

    const prompt = buildPrompt(intent, apisDir, relPath);

    expect(prompt).toContain(intent.instruction);
    expect(prompt).toContain('flows/hello.json');
    expect(prompt).toMatch(/emberflow-/);
    expect(prompt).toMatch(/emberflow-review-workflow/);
    expect(prompt).toMatch(/registerNodes/); // may author a node while editing
  });

  it('does not name the scenarios file for edit-node or edit-flow', () => {
    const editNode = buildPrompt(
      { action: 'edit-node', flowId: 'hello', nodeId: 'n1', instruction: 'x' },
      apisDir,
      relPath,
    );
    const editFlow = buildPrompt({ action: 'edit-flow', flowId: 'hello', instruction: 'x' }, apisDir, relPath);

    expect(editNode).not.toContain('.scenarios.json');
    expect(editFlow).not.toContain('.scenarios.json');
  });

  it('throws on an unrecognized intent.action instead of silently building a near-empty prompt', () => {
    const bogus = { action: 'delete-everything', flowId: 'hello', instruction: 'x' } as unknown as AgentIntent;
    expect(() => buildPrompt(bogus, apisDir, relPath)).toThrow(/unknown intent action/i);
  });

  it('new-operation: names the target apis/<location>/ dir, expresses the user goal, and asks for a single new operation with an http trigger and a Response node', () => {
    const intent: AgentIntent = {
      action: 'new-operation',
      location: 'billing',
      instruction: 'Let a customer request a refund for an order and notify billing ops.',
    };

    const prompt = buildPrompt(intent, 'flows', 'billing');

    expect(prompt).toContain(intent.instruction);
    expect(prompt).toContain('flows/billing');
    expect(prompt).toMatch(/emberflow-/);
    expect(prompt).toMatch(/create a brand-new operation/i);
    expect(prompt).toMatch(/http/i);
    expect(prompt).toMatch(/Response/);
    expect(prompt).toMatch(/Input/);
    // New-operation now leads with creating the shell via the CLI (name + method
    // + path), then building it out.
    expect(prompt).toMatch(/create the shell/i);
    expect(prompt).toMatch(/ create <id>/i);
  });

  it('build-api: owns the whole API surface — design judgment, placeholders-first then one-at-a-time build-out, the create CLI lines, and a finish summary', () => {
    const intent: AgentIntent = {
      action: 'build-api',
      location: 'billing',
      instruction: 'Manage customer invoices — draft, send, and track payment.',
    };

    const prompt = buildPrompt(intent, 'flows', 'billing');

    expect(prompt).toContain(intent.instruction);
    expect(prompt).toContain('flows/billing');
    // The agent designs the surface: how many operations, named what, HTTP vs internal.
    expect(prompt).toContain('API SURFACE');
    expect(prompt).toContain('YOUR design judgment');
    // The surface is declared up front (`plan` → sidebar ghost rows), then
    // each op is built out one at a time so the studio shows it taking shape.
    expect(prompt).toContain('DECLARE THE PLAN');
    expect(prompt).toMatch(/plan billing --ops/);
    // Multi-op surfaces group under a system folder instead of floating loose.
    expect(prompt).toContain('give it a home');
    expect(prompt).toContain('"<folder>/<slug>"');
    expect(prompt).toContain('ONE AT A TIME');
    expect(prompt).toContain('leave them alone');
    // Both create-CLI shapes: HTTP endpoint and internal sub-flow.
    expect(prompt).toMatch(/create billing\/<slug> --method <METHOD> --path <\/route>/);
    expect(prompt).toMatch(/create billing\/<slug> --name "<Display Name>"/);
    // The finish summary is what the studio turns into open buttons — exact ids matter.
    expect(prompt).toMatch(/FINISH with a one-line-per-operation summary/);
  });

  it('new-operation: resolves the default location to the "default" apis dir', () => {
    const prompt = buildPrompt(
      { action: 'new-operation', location: '', instruction: 'Send a welcome email on signup.' },
      'flows',
      'default',
    );

    expect(prompt).toContain('flows/default');
  });

  it('names the operation file by its relative path, not its id', () => {
    const prompt = buildPrompt(
      { action: 'edit-flow', flowId: 'triage', instruction: 'rename it' },
      '/proj/emberflow/apis',
      'default/triage',
    );
    expect(prompt).toContain('/proj/emberflow/apis/default/triage.json');
    expect(prompt).not.toContain('/proj/emberflow/apis/triage.json');
  });

  it('includes the available node types and the register-before-reference guardrail, for every intent action', () => {
    const availableNodes = [
      { type: 'Input' },
      { type: 'Response' },
      { type: 'ValidateCredentials', label: 'Validate Credentials', description: 'Checks a username/password pair.' },
      { type: 'FetchUser', label: 'Fetch User' },
    ];

    const intents: AgentIntent[] = [
      { action: 'new-scenario', flowId: 'hello', instruction: 'x' },
      { action: 'edit-node', flowId: 'hello', nodeId: 'n1', instruction: 'x' },
      { action: 'edit-flow', flowId: 'hello', instruction: 'x' },
      { action: 'new-operation', location: 'billing', instruction: 'x' },
    ];

    for (const intent of intents) {
      const prompt = buildPrompt(intent, apisDir, relPath, availableNodes);
      expect(prompt).toMatch(/reuse/i); // reuse existing before authoring
      expect(prompt).toMatch(/register its implementation/i); // the guardrail: register before reference
      expect(prompt).toContain('Input');
      expect(prompt).toContain('Response');
      expect(prompt).toContain('ValidateCredentials');
      expect(prompt).toContain('Validate Credentials');
      expect(prompt).toContain('Checks a username/password pair.');
      expect(prompt).toContain('FetchUser');
    }
  });

  it('with no available nodes reported, tells the agent to author the nodes it needs', () => {
    const prompt = buildPrompt({ action: 'edit-flow', flowId: 'hello', instruction: 'x' }, apisDir, relPath);
    expect(prompt).toMatch(/author the nodes/i);
  });

  it('forbids the agent from switching serving mode itself — a real incident: an agent flipped to real mid-task and later runs hit the database', () => {
    const prompt = buildPrompt({ action: 'edit-flow', flowId: 'hello', instruction: 'x' }, apisDir, relPath);
    expect(prompt).toMatch(/NEVER switch this yourself/);
    expect(prompt).toMatch(/say so in your final message instead of flipping the mode/);
  });

  it('includes the login-environment CLI command and the AUTH guidance section', () => {
    const prompt = buildPrompt({ action: 'edit-flow', flowId: 'hello', instruction: 'x' }, apisDir, relPath);

    expect(prompt).toContain(
      '- login-environment <name> — perform the environment\'s configured login and store its credential runner-side; run this if operations fail 401/unauthorized and list-environments shows auth configured but not authenticated.',
    );
    expect(prompt).toMatch(/«secret:KEY»/);
    expect(prompt).toMatch(/emberflow\.environments\.json/);
    expect(prompt).toMatch(/login-environment <name>/);
  });

  it('setup-auth: names the environment, includes the instruction verbatim, the apply command, and both NEVER rules', () => {
    const intent: AgentIntent = {
      action: 'setup-auth',
      environment: 'dev',
      instruction: "curl -X POST https://api.example.com/login -d '{...}' returns a Set-Cookie session token",
    };

    const prompt = buildPrompt(intent, 'flows', 'default');

    expect(prompt).toContain(intent.instruction);
    expect(prompt).toContain('dev');
    expect(prompt).toMatch(/set-environment-auth dev --json/);
    expect(prompt).toMatch(/NEVER read or edit emberflow\.environments\.json directly/i);
    expect(prompt).toMatch(/NEVER ask for or handle credential values/i);
    expect(prompt).toMatch(/login-environment dev/);
    expect(prompt).toMatch(/list-environments/);
  });

  it('setup-environments: includes the instruction verbatim, environments-file path guidance, the protected-for-prod rule, the never-write-secret-values rule, and a Manage-dialog/login pointer', () => {
    const intent: AgentIntent = {
      action: 'setup-environments',
      instruction: 'We have a dev environment at https://dev.api.example.com and a prod environment at https://api.example.com, prod needs an API key.',
    };

    const prompt = buildPrompt(intent, apisDir, relPath);

    expect(prompt).toContain(intent.instruction);
    expect(prompt).toMatch(/emberflow\.environments\.json/);
    expect(prompt).toMatch(/"protected"\s*:\s*true/);
    expect(prompt).toMatch(/NEVER (invent|write) .*secret|credential.*value/i);
    expect(prompt).toMatch(/Manage Environment dialog/i);
    expect(prompt).toMatch(/login-environment/);
  });

  it('setup-environments: fences the agent to the user description — no code/infra/MCP investigation, placeholders for unknowns', () => {
    const prompt = buildPrompt(
      { action: 'setup-environments', instruction: 'dev and prod please' },
      apisDir,
      relPath,
    );
    expect(prompt).toMatch(/description ALONE/);
    expect(prompt).toMatch(/do NOT explore .*deployment providers.*MCP/i);
    expect(prompt).toMatch(/placeholder var/);
  });

  it('setup-environments does NOT get the doctor global rule (it edits emberflow.environments.json, not an operation)', () => {
    const prompt = buildPrompt(
      { action: 'setup-environments', instruction: 'Set up a dev environment.' },
      apisDir,
      relPath,
    );
    expect(prompt).not.toMatch(/run doctor/i);
    expect(prompt).not.toMatch(/resolve its findings/i);
  });

  it('cover-operation: names the flow + scenarios files, includes instruction verbatim, the branch-coverage instruction, the never-weaken rule, and the test verification command', () => {
    const intent: AgentIntent = {
      action: 'cover-operation',
      flowId: 'hello',
      instruction: 'Cover every branch of the operation with scenarios.',
    };

    const prompt = buildPrompt(intent, apisDir, relPath);

    expect(prompt).toContain(intent.instruction);
    expect(prompt).toContain('flows/hello.json');
    expect(prompt).toContain('flows/hello.scenarios.json');
    expect(prompt).toMatch(/every Route\/Conditional branch/i);
    expect(prompt).toMatch(/terminal Response\/Result/i);
    expect(prompt).toMatch(/executedNodes/);
    expect(prompt).toMatch(/NEVER weaken or delete an existing expect/i);
    expect(prompt).toMatch(/test hello/);
    // The mechanical "every scenario must supply every :param" law now lives in
    // `doctor`'s findings; the prompt keeps only the real-id taste guidance.
    expect(prompt).toMatch(/real id from the project's data/i);
  });

  it('cover-operation: carries the mocks-map guidance (op-level + per-scenario shape, infra traceKind, realistic output) and the never-secrets-in-mocks rule', () => {
    const intent: AgentIntent = {
      action: 'cover-operation',
      flowId: 'hello',
      instruction: 'Cover every branch of the operation with scenarios.',
    };

    const prompt = buildPrompt(intent, apisDir, relPath);

    expect(prompt).toMatch(/traceKind.*"db".*"http".*"llm"/i);
    expect(prompt).toMatch(/"mocks"/);
    expect(prompt).toMatch(/nodeId/);
    expect(prompt).toMatch(/op-level.*mocks.*plain Run|plain Run.*op-level.*mocks/i);
    expect(prompt).toMatch(/per-scenario.*mocks.*overrides/i);
    expect(prompt).toMatch(/read (the )?node'?s? implementation/i);
    expect(prompt).toMatch(/never put secret values in (a |the )?mocks/i);
  });

  it('new-scenario: carries the mocks-map guidance and the never-secrets-in-mocks rule', () => {
    const intent: AgentIntent = {
      action: 'new-scenario',
      flowId: 'hello',
      instruction: 'Add a scenario for the timeout branch.',
    };

    const prompt = buildPrompt(intent, apisDir, relPath);

    expect(prompt).toMatch(/traceKind.*"db".*"http".*"llm"/i);
    expect(prompt).toMatch(/"mocks"/);
    expect(prompt).toMatch(/never put secret values in (a |the )?mocks/i);
  });

  it('edit-flow and new-operation carry the traceKind-honesty node-authoring nudge', () => {
    const editFlow = buildPrompt({ action: 'edit-flow', flowId: 'hello', instruction: 'x' }, apisDir, relPath);
    const scaffold = buildPrompt(
      { action: 'edit-flow', flowId: 'placeholder-name', instruction: 'x', scaffold: true },
      apisDir,
      relPath,
    );
    const newOperation = buildPrompt({ action: 'new-operation', location: 'billing', instruction: 'x' }, apisDir, relPath);

    for (const prompt of [editFlow, scaffold, newOperation]) {
      expect(prompt).toMatch(/set (its |the )?traceKind honestly/i);
      expect(prompt).toMatch(/mock-mode infrastructure boundary/i);
    }
  });

  it('setup-environments does NOT gain the mocks or traceKind-honesty guidance', () => {
    const prompt = buildPrompt({ action: 'setup-environments', instruction: 'dev and prod please' }, apisDir, relPath);

    expect(prompt).not.toMatch(/traceKind/i);
    expect(prompt).not.toMatch(/"mocks"/);
    expect(prompt).not.toMatch(/never put secret values in (a |the )?mocks/i);
  });

  it('CLI catalog lists the doctor command', () => {
    const intent: AgentIntent = { action: 'edit-flow', flowId: 'hello', instruction: 'x' };
    const prompt = buildPrompt(intent, apisDir, relPath);
    expect(prompt).toContain(
      '- doctor [<id>] [--fix] — report operation diagnostics (missing param defaults, uncovered path params, missing expects); --fix auto-seeds missing param defaults. Run it on any operation you created or edited and resolve every finding before you finish.',
    );
  });

  it('every flow-mutating intent tells the agent to run doctor and resolve its findings before finishing', () => {
    const intents: AgentIntent[] = [
      { action: 'new-scenario', flowId: 'hello', instruction: 'x' },
      { action: 'edit-node', flowId: 'hello', nodeId: 'n1', instruction: 'x' },
      { action: 'edit-flow', flowId: 'hello', instruction: 'x' },
      { action: 'new-operation', location: 'billing', instruction: 'x' },
      { action: 'cover-operation', flowId: 'hello', instruction: 'x' },
    ];

    for (const intent of intents) {
      const prompt = buildPrompt(intent, apisDir, relPath);
      expect(prompt).toMatch(/run doctor/i);
      expect(prompt).toMatch(/resolve its findings/i);
      expect(prompt).toMatch(/doctor --fix seeds missing param defaults/i);
    }
  });

  it('edit-flow scaffold path also tells the agent to run doctor', () => {
    const prompt = buildPrompt(
      { action: 'edit-flow', flowId: 'placeholder-name', instruction: 'x', scaffold: true },
      apisDir,
      relPath,
    );
    expect(prompt).toMatch(/run doctor/i);
  });

  it('setup-auth does NOT get the doctor global rule (it edits emberflow.environments.json, not an operation) — the CLI catalog entry is still listed', () => {
    const prompt = buildPrompt(
      { action: 'setup-auth', environment: 'dev', instruction: 'x' },
      apisDir,
      relPath,
    );
    expect(prompt).not.toMatch(/run doctor/i);
    expect(prompt).not.toMatch(/resolve its findings/i);
    // The shared CLI catalog (listed for every intent) still names the command.
    expect(prompt).toMatch(/- doctor \[<id>\]/);
  });

  it('ask (with a flow): names the flow file, includes the question verbatim, enforces the no-edit rule, and carries the inspection order', () => {
    const intent: AgentIntent = {
      action: 'ask',
      flowId: 'hello',
      instruction: 'Which node decides whether the request is authorized?',
    };

    const prompt = buildPrompt(intent, apisDir, relPath);

    expect(prompt).toContain(intent.instruction);
    expect(prompt).toContain('flows/hello.json');
    // No-edit rule: this is a question, answer it and change nothing.
    expect(prompt).toMatch(/QUESTION, not an edit/i);
    expect(prompt).toMatch(/change NOTHING/i);
    expect(prompt).toMatch(/Do NOT write, create, save, edit, delete, or rename/i);
    // Inspection order (shared preamble) is present.
    expect(prompt).toMatch(/INSPECTION ORDER/);
    expect(prompt).toMatch(/list-workflows.*get-workflow.*get-node.*node-schema.*samples/);
    // Answer-format guidance.
    expect(prompt).toMatch(/LEAD with the direct answer/i);
  });

  it('ask (without a flow): frames it as a project-wide question, still no-edit + inspection order', () => {
    const intent: AgentIntent = {
      action: 'ask',
      instruction: 'How many operations touch the database?',
    };

    // For a flow-less ask the caller passes the apis root (empty relPath).
    const prompt = buildPrompt(intent, apisDir, '');

    expect(prompt).toContain(intent.instruction);
    expect(prompt).toMatch(/question about this Emberflow project/i);
    expect(prompt).not.toMatch(/\.json\b.*question|question.*flows\/hello\.json/);
    expect(prompt).toMatch(/QUESTION, not an edit/i);
    expect(prompt).toMatch(/change NOTHING/i);
    expect(prompt).toMatch(/INSPECTION ORDER/);
    expect(prompt).toMatch(/list-workflows.*get-workflow.*get-node.*node-schema.*samples/);
  });

  it('ask does NOT get the doctor global rule (it changes nothing)', () => {
    const prompt = buildPrompt({ action: 'ask', flowId: 'hello', instruction: 'x' }, apisDir, relPath);
    expect(prompt).not.toMatch(/run doctor .*resolve its findings/i);
  });

  it('CLI catalog lists the get-node command and the inspection order (every intent)', () => {
    const prompt = buildPrompt({ action: 'edit-flow', flowId: 'hello', instruction: 'x' }, apisDir, relPath);
    expect(prompt).toMatch(/- get-node <id> <nodeId>/);
    expect(prompt).toMatch(/INSPECTION ORDER/);
  });

  it('CLI catalog lists the test command', () => {
    const intent: AgentIntent = { action: 'edit-flow', flowId: 'hello', instruction: 'x' };
    const prompt = buildPrompt(intent, apisDir, relPath);
    expect(prompt).toMatch(/- test <id> — run the operation's scenario expectations in-process/);
  });

  it('shared test-as-you-build guidance keeps the run+nodeStates debugging step and adds scenario expects + a final test run', () => {
    for (const intent of [
      { action: 'edit-flow', flowId: 'hello', instruction: 'x' } as AgentIntent,
      { action: 'new-operation', location: 'billing', instruction: 'x' } as AgentIntent,
    ]) {
      const prompt = buildPrompt(intent, apisDir, relPath);
      expect(prompt).toMatch(/read.{0,20}nodeStates/i); // existing run-and-read guidance stays
      expect(prompt).toMatch(/scenarios sidecar.*expect/i);
      expect(prompt).toMatch(/node .*test <id>/);
    }
  });

  it('defaults to typescript-driven guidance when projectLanguage is omitted', () => {
    const intent: AgentIntent = { action: 'edit-flow', flowId: 'hello', instruction: 'x' };
    const prompt = buildPrompt(intent, apisDir, relPath);
    expect(prompt).toMatch(/This project is typescript-driven.*TypeScript \(\.ts, typed\).*do not introduce JavaScript files into it/);
  });

  it('states javascript-driven guidance when projectLanguage is "javascript"', () => {
    const intent: AgentIntent = { action: 'edit-flow', flowId: 'hello', instruction: 'x' };
    const prompt = buildPrompt(intent, apisDir, relPath, [], 'javascript');
    expect(prompt).toMatch(/This project is javascript-driven.*JavaScript \(\.mjs\/\.js, JSDoc types\).*do not introduce TypeScript files into it/);
    expect(prompt).not.toMatch(/This project is typescript-driven/);
  });

  it('states typescript-driven guidance when projectLanguage is explicitly "typescript"', () => {
    const intent: AgentIntent = { action: 'edit-flow', flowId: 'hello', instruction: 'x' };
    const prompt = buildPrompt(intent, apisDir, relPath, [], 'typescript');
    expect(prompt).toMatch(/This project is typescript-driven.*TypeScript \(\.ts, typed\).*do not introduce JavaScript files into it/);
    expect(prompt).not.toMatch(/This project is javascript-driven/);
  });

  describe('scout-infrastructure', () => {
    const scout: AgentIntent = {
      action: 'scout-infrastructure',
      instruction: 'Scan this project for infrastructure it already uses.',
    };

    it('states the JOB is to read the project and INVERTS the setup-environments no-explore rule', () => {
      const prompt = buildPrompt(scout, apisDir, relPath);
      expect(prompt).toContain(scout.instruction);
      expect(prompt).toMatch(/your JOB.*is to READ the project/i);
      expect(prompt).toMatch(/INVERT/i);
      expect(prompt).toMatch(/do NOT explore/); // references the rule it inverts
    });

    it('enumerates deps/config/ORM/env-var refs/HTTP clients/routes and the manifest kinds', () => {
      const prompt = buildPrompt(scout, apisDir, relPath);
      expect(prompt).toMatch(/package\.json/);
      expect(prompt).toMatch(/requirements\.txt/);
      expect(prompt).toMatch(/go\.mod/);
      expect(prompt).toMatch(/prisma\/schema\.prisma/);
      expect(prompt).toMatch(/process\.env/);
      expect(prompt).toMatch(/HTTP clients/i);
      expect(prompt).toMatch(/route/i);
      expect(prompt).toMatch(/database, http-api, queue, cache, email, llm, auth, framework, storage, other/);
    });

    it('tells the agent to WRITE emberflow/infrastructure.json in the manifest shape', () => {
      const prompt = buildPrompt(scout, apisDir, relPath);
      expect(prompt).toMatch(/WRITE the manifest to emberflow\/infrastructure\.json/);
      expect(prompt).toMatch(/create the emberflow\/ directory/i);
      expect(prompt).toMatch(/"scannedAt"/);
      expect(prompt).toMatch(/"greenfield"/);
      expect(prompt).toMatch(/"suggestedSecretRefs"/);
      expect(prompt).toMatch(/"evidence"/);
    });

    it('forbids copying secret VALUES — env-var NAMES only — and states it twice', () => {
      const prompt = buildPrompt(scout, apisDir, relPath);
      const nameOnlyMatches = prompt.match(/NAMES ONLY|only names|no secret values/gi) ?? [];
      // Stated at least twice (the hard rule + the closing double-check reminder).
      expect(nameOnlyMatches.length).toBeGreaterThanOrEqual(2);
      expect(prompt).toMatch(/NEVER copy a secret VALUE/i);
      expect(prompt).toMatch(/stated twice on purpose/i);
    });

    it('covers greenfield handling and the closing summary + open questions', () => {
      const prompt = buildPrompt(scout, apisDir, relPath);
      expect(prompt).toMatch(/greenfield.*true/i);
      expect(prompt).toMatch(/open questions/i);
    });

    it('supports amending an existing manifest in place for targeted add/remove/correct instructions', () => {
      const prompt = buildPrompt(scout, apisDir, relPath);
      expect(prompt).toMatch(/AMENDMENT vs FULL RESCAN/);
      expect(prompt).toMatch(/UPDATE that file in place/i);
      expect(prompt).toMatch(/preserve every item you were not asked to change/i);
      expect(prompt).toMatch(/bump "scannedAt"/);
      expect(prompt).toMatch(/FULL RESCAN.*remains the default/i);
    });

    it('does NOT get the doctor rule, the mocks guidance, or the traceKind nudge (it edits no operation)', () => {
      const prompt = buildPrompt(scout, apisDir, relPath);
      expect(prompt).not.toMatch(/run doctor/i);
      expect(prompt).not.toMatch(/"mocks"/);
      expect(prompt).not.toMatch(/set (its |the )?traceKind honestly/i);
    });

    it('does NOT receive the known-infrastructure preamble even when a manifest is passed (it writes it)', () => {
      const manifest = {
        version: 1,
        greenfield: false,
        items: [
          { id: 'pg', kind: 'database' as const, name: 'Postgres', evidence: [], suggestedSecretRefs: ['DATABASE_URL'], suggestedVars: [] },
        ],
      };
      const prompt = buildPrompt(scout, apisDir, relPath, [], 'typescript', manifest);
      expect(prompt).not.toMatch(/Known project infrastructure \(from/);
    });
  });

  describe('guided-setup', () => {
    const guided: AgentIntent = {
      action: 'guided-setup',
      instruction: 'I want dev and prod environments.',
    };

    it('includes the user notes verbatim and orchestrates the steps IN ORDER, reading state first + skipping done work', () => {
      const prompt = buildPrompt(guided, apisDir, relPath);
      expect(prompt).toContain(guided.instruction);
      expect(prompt).toMatch(/IN ORDER/);
      expect(prompt).toMatch(/READ THE GROUND TRUTH FIRST/);
      expect(prompt).toMatch(/skip(ping)? .*(done|already satisfied)/i);
    });

    it('explicitly PERMITS exploration (unlike setup-environments) — it may read the project like the scout', () => {
      const prompt = buildPrompt(guided, apisDir, relPath);
      expect(prompt).toMatch(/MAY read the project/i);
      expect(prompt).toMatch(/the way the infrastructure scout does/i);
      // Names the setup-environments no-explore rule it is inverting.
      expect(prompt).toMatch(/setup-environments/);
    });

    it('covers greenfield vs brownfield judgment and writes the infrastructure manifest', () => {
      const prompt = buildPrompt(guided, apisDir, relPath);
      expect(prompt).toMatch(/GREENFIELD/);
      expect(prompt).toMatch(/BROWNFIELD/);
      expect(prompt).toMatch(/emberflow\/infrastructure\.json/);
      expect(prompt).toMatch(/"greenfield": true/);
    });

    it('installs skills via the in-process bin with the project-language flag (--ts for a TS project)', () => {
      const prompt = buildPrompt(guided, apisDir, relPath, [], 'typescript');
      expect(prompt).toMatch(/emberflow\.mjs init --local --no-launch --no-git --ts/);
    });

    it('installs skills with --js for a javascript project', () => {
      const prompt = buildPrompt(guided, apisDir, relPath, [], 'javascript');
      expect(prompt).toMatch(/emberflow\.mjs init --local --no-launch --no-git --js/);
    });

    // With a runner-verified snapshot, the prompt states KNOWN facts and
    // forbids re-probing them — no wasted first turn of CLI checks.
    it('injects the runner-verified state as KNOWN facts instead of a probe step', () => {
      const prompt = buildPrompt(guided, apisDir, relPath, [], 'typescript', null, {
        gitRepo: true,
        skillsInstalled: true,
        environmentsConfigured: false,
        infrastructurePresent: false,
        opCount: 1,
        onlyHello: true,
      });
      expect(prompt).toMatch(/KNOWN PROJECT STATE/);
      expect(prompt).toMatch(/TRUST it, do not re-check/);
      expect(prompt).toMatch(/git repository: yes/);
      expect(prompt).toMatch(/only the default hello example/);
      expect(prompt).not.toMatch(/READ THE GROUND TRUTH FIRST/);
    });

    it('missing git in the snapshot carries the stop-and-tell-user instruction', () => {
      const prompt = buildPrompt(guided, apisDir, relPath, [], 'typescript', null, {
        gitRepo: false,
        skillsInstalled: false,
        environmentsConfigured: false,
        infrastructurePresent: false,
        opCount: 1,
        onlyHello: true,
      });
      expect(prompt).toMatch(/There is NO git repository: STOP/);
    });

    it('without a snapshot, falls back to the self-probe ground-truth step', () => {
      const prompt = buildPrompt(guided, apisDir, relPath);
      expect(prompt).toMatch(/READ THE GROUND TRUTH FIRST/);
    });

    it('runs the environments interview and ENDS with numbered questions', () => {
      const prompt = buildPrompt(guided, apisDir, relPath);
      expect(prompt).toMatch(/ENVIRONMENTS INTERVIEW/);
      expect(prompt).toMatch(/emberflow\.environments\.json/);
      // The interview is a staged, structured form: ask BEFORE writing, via
      // the emberflow-questions block the studio renders interactively —
      // and skipping it is called out as failing the step.
      expect(prompt).toMatch(/ask FIRST \(on the very first turn/i);
      // Turn-shape contract: questions land immediately, work happens after.
      expect(prompt).toMatch(/TURN SHAPE/);
      expect(prompt).toMatch(/run NO commands and write NO files first/);
      expect(prompt).toMatch(/emberflow-questions/);
      expect(prompt).toMatch(/asks nothing has FAILED/i);
      // Local-first: people build mock → local → dev/prod; local leads the
      // options, is the proposed default, and a scouted localhost URL feeds it.
      expect(prompt).toMatch(/LOCAL FIRST/);
      // Mock-first frame: the greeting must say builds start on example data,
      // and never assume dev/staging as the starting point.
      expect(prompt).toMatch(/starts in MOCK mode/);
      expect(prompt).toMatch(/mock → local → real environments/);
      expect(prompt).toMatch(/local only \(add others later\)/);
      expect(prompt).toMatch(/default to "local"/);
      // Terse-output contract + the closing first-build question with the
      // look-around escape hatch.
      expect(prompt).toMatch(/Be TERSE/);
      expect(prompt).toMatch(/What do you want to build first\?/);
      expect(prompt).toMatch(/"action":"finish"/);
    });

    it('never writes secret VALUES and states the connection-proof + wrap-up summary', () => {
      const prompt = buildPrompt(guided, apisDir, relPath);
      expect(prompt).toMatch(/NEVER write secret or credential VALUES/i);
      expect(prompt).toMatch(/CONNECTION PROOF/);
      expect(prompt).toMatch(/no model ids/i);
      expect(prompt).toMatch(/WRAP-UP \+ FIRST BUILD/);
      expect(prompt).toMatch(/One line per completed step/);
    });

    it('does NOT get the doctor rule, mocks guidance, or the known-infrastructure preamble (it writes the manifest)', () => {
      const manifest = {
        version: 1,
        greenfield: false,
        items: [
          { id: 'pg', kind: 'database' as const, name: 'Postgres', evidence: [], suggestedSecretRefs: ['DATABASE_URL'], suggestedVars: [] },
        ],
      };
      const prompt = buildPrompt(guided, apisDir, relPath, [], 'typescript', manifest);
      expect(prompt).not.toMatch(/run doctor/i);
      expect(prompt).not.toMatch(/"mocks"/);
      expect(prompt).not.toMatch(/Known project infrastructure \(from/);
    });
  });

  describe('known-infrastructure preamble injection', () => {
    const editFlow: AgentIntent = { action: 'edit-flow', flowId: 'hello', instruction: 'x' };
    const manifest = {
      version: 1,
      scannedAt: '2026-07-12T00:00:00Z',
      greenfield: false,
      summary: 'Express + Postgres + Stripe.',
      items: [
        {
          id: 'postgres-main',
          kind: 'database' as const,
          name: 'Postgres (Prisma)',
          evidence: [{ file: 'prisma/schema.prisma', note: 'datasource db' }],
          suggestedSecretRefs: ['DATABASE_URL'],
          suggestedVars: [],
        },
        {
          id: 'stripe',
          kind: 'http-api' as const,
          name: 'Stripe',
          evidence: [{ file: 'package.json', note: 'stripe dep' }],
          suggestedSecretRefs: ['STRIPE_SECRET_KEY'],
          suggestedVars: [],
        },
      ],
    };

    it('with a manifest: lists each item (name/kind — secretRefs — evidence file) and the REUSE rule', () => {
      const prompt = buildPrompt(editFlow, apisDir, relPath, [], 'typescript', manifest);
      expect(prompt).toMatch(/Known project infrastructure \(from emberflow\/infrastructure\.json/);
      expect(prompt).toContain('Postgres (Prisma) (database)');
      expect(prompt).toContain('secretRefs: DATABASE_URL');
      expect(prompt).toContain('see prisma/schema.prisma');
      expect(prompt).toContain('Stripe (http-api)');
      expect(prompt).toContain('secretRefs: STRIPE_SECRET_KEY');
      expect(prompt).toMatch(/REUSE rule.*REUSE it/i);
    });

    it('without a manifest: one line noting none on record and suggesting the scout', () => {
      const prompt = buildPrompt(editFlow, apisDir, relPath, [], 'typescript', null);
      expect(prompt).toMatch(/Known project infrastructure: none on record/i);
      expect(prompt).toMatch(/infrastructure scout/i);
      expect(prompt).not.toMatch(/Known project infrastructure \(from/);
    });

    it('greenfield manifest: says greenfield rather than listing items', () => {
      const prompt = buildPrompt(editFlow, apisDir, relPath, [], 'typescript', {
        version: 1,
        greenfield: true,
        items: [],
      });
      expect(prompt).toMatch(/marks this project greenfield/i);
    });

    it('caps the item listing at 30 and appends a "+N more" line pointing at the manifest/scout', () => {
      const items = Array.from({ length: 35 }, (_, i) => ({
        id: `item-${i}`,
        kind: 'http-api' as const,
        name: `Service ${i}`,
        evidence: [],
        suggestedSecretRefs: [],
        suggestedVars: [],
      }));
      const prompt = buildPrompt(editFlow, apisDir, relPath, [], 'typescript', {
        version: 1,
        greenfield: false,
        items,
      });
      expect(prompt).toContain('Service 0 (http-api)');
      expect(prompt).toContain('Service 29 (http-api)');
      expect(prompt).not.toContain('Service 30 (http-api)');
      expect(prompt).not.toContain('Service 34 (http-api)');
      expect(prompt).toMatch(/\(\+5 more — see emberflow\/infrastructure\.json or re-run the scout\)/);
    });

    it('does not append a "+N more" line when items are at or under the cap', () => {
      const prompt = buildPrompt(editFlow, apisDir, relPath, [], 'typescript', manifest);
      expect(prompt).not.toMatch(/more — see emberflow\/infrastructure\.json/);
    });

    it('non-greenfield manifest present but with no items: distinct "exists but lists no items" wording', () => {
      const prompt = buildPrompt(editFlow, apisDir, relPath, [], 'typescript', {
        version: 1,
        greenfield: false,
        items: [],
      });
      expect(prompt).toMatch(/infrastructure manifest exists but lists no items/i);
      expect(prompt).toMatch(/re-run the scout/i);
      // Distinct from both the "none on record" and "greenfield" branches.
      expect(prompt).not.toMatch(/Known project infrastructure: none on record/i);
      expect(prompt).not.toMatch(/marks this project greenfield/i);
    });

    it('preamble reaches new-operation too (the intent most likely to need reuse)', () => {
      const prompt = buildPrompt(
        { action: 'new-operation', location: 'billing', instruction: 'charge a card' },
        apisDir,
        relPath,
        [],
        'typescript',
        manifest,
      );
      expect(prompt).toContain('Stripe (http-api)');
      expect(prompt).toMatch(/REUSE rule/i);
    });
  });
});
