import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DoneSummary, GuidedSetupIntro, GuidedSetupPanes, WelcomeChecklist } from './WelcomeDialog';
import type { WelcomeChecklistActions } from './WelcomeDialog';
import type { SetupStatus } from '../store/setupClient';

/** A pristine, just-initialized project: no agent, no environments, no skills,
 *  only the hello example op. */
const FRESH: SetupStatus = {
  agents: [],
  git: { repo: false },
  environments: { configured: false, count: 0, protectedCount: 0, anyAuthConfigured: false },
  skills: { claude: false, codex: false },
  language: 'typescript',
  ops: { count: 1, onlyHello: true },
  servingMode: 'mock',
  infrastructure: { present: false },
};

/** A project that's been set up: agent on PATH, environments + auth, skills
 *  installed, infrastructure scouted, several ops. */
const CONFIGURED: SetupStatus = {
  agents: [
    { kind: 'claude', version: '2.1.0' },
    { kind: 'codex', version: '0.5.3' },
  ],
  git: { repo: true },
  environments: { configured: true, count: 2, protectedCount: 1, anyAuthConfigured: true },
  skills: { claude: true, codex: false },
  language: 'typescript',
  ops: { count: 4, onlyHello: false },
  servingMode: 'real',
  infrastructure: { present: true, itemCount: 3 },
};

const html = (status: SetupStatus): string =>
  renderToStaticMarkup(<WelcomeChecklist status={status} />);

describe('WelcomeChecklist', () => {
  it('renders every checklist row', () => {
    const out = html(FRESH);
    for (const title of [
      'Git repository',
      'Coding agent',
      'Environments',
      'Secrets &amp; auth',
      'Agent skills',
      'Infrastructure scouted',
      'First operation',
    ]) {
      expect(out).toContain(title);
    }
  });

  it('fresh project: shows the git init command and disables agent-driven actions', () => {
    const out = html(FRESH);
    expect(out).toContain('git init &amp;&amp; git add -A &amp;&amp; git commit -m &quot;initial&quot;');
    // With no git repo, the agent-dependent rows say to initialize git first.
    expect(out).toContain('Initialize git first');
  });

  it('git row completes once the repo exists', () => {
    const out = html(CONFIGURED);
    expect(out).toContain('Repository ready');
    expect(out).not.toContain('Initialize git first');
  });

  it('fresh project: shows the install hint and no completed rows', () => {
    const out = html(FRESH);
    // Skills-missing hint is the copyable init command, no action button.
    expect(out).toContain('npx emberflow init --local --no-launch');
    expect(out).toContain('None detected on PATH');
    // Nothing is done yet — no "done" glyph.
    expect(out).not.toContain('aria-label="done"');
  });

  it('git present but no agent: the scout button is disabled with the agent reason', () => {
    // Git is the earlier prerequisite; with it satisfied the scout row falls
    // through to the "detect an agent" reason.
    const out = html({ ...FRESH, git: { repo: true } });
    expect(out).toContain('Detect a coding agent first');
    expect(out).toMatch(/Scout/);
    expect(out).toContain('disabled');
  });

  it('configured project: shows completed rows and agent versions', () => {
    const out = html(CONFIGURED);
    expect(out).toContain('aria-label="done"');
    expect(out).toContain('claude 2.1.0');
    expect(out).toContain('codex 0.5.3');
    expect(out).toContain('2 environments, 1 protected');
    // Skills present → no install hint.
    expect(out).not.toContain('npx emberflow init');
  });

  it('configured project: scout is enabled (agent present)', () => {
    const out = html(CONFIGURED);
    expect(out).not.toContain('Detect a coding agent first');
  });

  it('two agents + onChooseAgent: renders the picker with the chosen agent pressed', () => {
    const out = renderToStaticMarkup(
      <WelcomeChecklist status={CONFIGURED} chosenAgent="codex" onChooseAgent={() => {}} />,
    );
    expect(out).toContain('Choose coding agent');
    // Codex is the active choice; Claude is not.
    expect(out).toMatch(/aria-pressed="true"[^>]*>Codex/);
    expect(out).toMatch(/aria-pressed="false"[^>]*>Claude/);
  });

  it('single agent: no picker even when onChooseAgent is provided', () => {
    const oneAgent: SetupStatus = { ...CONFIGURED, agents: [{ kind: 'claude', version: '2.1.0' }] };
    const out = renderToStaticMarkup(
      <WelcomeChecklist status={oneAgent} onChooseAgent={() => {}} />,
    );
    expect(out).not.toContain('Choose coding agent');
    expect(out).toContain('claude 2.1.0');
  });

  it('progress + next-step emphasis: fresh shows 0/6 with the first row emphasized; fully-done has no next step', () => {
    const fresh = html(FRESH);
    expect(fresh).toContain('0 of 7 steps done');
    expect(fresh).toContain('bg-highlight/[0.06]'); // exactly one emphasized row
    expect(fresh.split('bg-highlight/[0.06]').length - 1).toBe(1);

    const done = html(CONFIGURED);
    expect(done).toContain('7 of 7 steps done');
    expect(done).not.toContain('bg-highlight/[0.06]'); // nothing left to emphasize
  });
});

/** Git + a coding agent (the two manual prerequisites) satisfied, but the rest
 *  of setup still to do — the state in which Start setup is enabled. */
const READY: SetupStatus = {
  ...FRESH,
  git: { repo: true },
  agents: [{ kind: 'claude', version: '2.1.0' }],
};

const NOOP: WelcomeChecklistActions = {
  onOpenSettings: () => {},
  onSetupEnvironments: () => {},
  onOpenEnvironments: () => {},
  onOpenHelloOp: () => {},
  onScoutInfrastructure: () => {},
};

describe('GuidedSetupIntro (idle phase)', () => {
  it('fresh project (no git): Start setup is disabled with the git reason', () => {
    const out = renderToStaticMarkup(<GuidedSetupIntro status={FRESH} onStart={() => {}} />);
    expect(out).toContain('Let the agent set this up');
    expect(out).toContain('Start setup');
    expect(out).toContain('disabled=""');
    expect(out).toContain('Initialize git first');
  });

  it('git present but no agent: disabled with the agent reason', () => {
    const out = renderToStaticMarkup(
      <GuidedSetupIntro status={{ ...FRESH, git: { repo: true } }} onStart={() => {}} />,
    );
    expect(out).toContain('disabled=""');
    expect(out).toContain('Detect a coding agent first');
  });

  it('ready project: Start enabled, the step-list names what still remains', () => {
    const out = renderToStaticMarkup(<GuidedSetupIntro status={READY} onStart={() => {}} />);
    expect(out).not.toContain('disabled=""');
    // Remaining steps derived from checklist state.
    expect(out).toContain('Scout your code for existing infrastructure');
    expect(out).toContain('Set up environments');
    expect(out).toContain('Install the agent skills');
    expect(out).toContain('Verify the skills and its own connection');
  });

  it('configured project: step-list drops done steps but always verifies connection', () => {
    const out = renderToStaticMarkup(<GuidedSetupIntro status={CONFIGURED} onStart={() => {}} />);
    expect(out).not.toContain('Scout your code');
    expect(out).not.toContain('Set up environments');
    expect(out).not.toContain('Install the agent skills');
    expect(out).toContain('Verify the skills and its own connection');
  });

  it('two agents: the guided card hosts the backend picker with the chosen agent pressed', () => {
    const twoAgents: SetupStatus = { ...READY, agents: CONFIGURED.agents };
    const out = renderToStaticMarkup(
      <GuidedSetupIntro status={twoAgents} chosenAgent="claude" onChooseAgent={() => {}} onStart={() => {}} />,
    );
    expect(out).toContain('Runs with');
    expect(out).toMatch(/aria-pressed="true"[^>]*>Claude/);
  });

  it('single agent: no picker in the guided card', () => {
    const out = renderToStaticMarkup(
      <GuidedSetupIntro status={READY} chosenAgent="claude" onChooseAgent={() => {}} onStart={() => {}} />,
    );
    expect(out).not.toContain('Choose coding agent');
  });
});

describe('DoneSummary', () => {
  it('joins completed step titles into one line, with agent versions', () => {
    const out = renderToStaticMarkup(<DoneSummary status={READY} />);
    expect(out).toContain('Git repository');
    expect(out).toContain('claude 2.1.0');
    expect(out).not.toContain('Environments');
  });

  it('renders nothing when no steps are complete', () => {
    const none: SetupStatus = { ...FRESH };
    expect(renderToStaticMarkup(<DoneSummary status={none} />)).toBe('');
  });
});

describe('GuidedSetupPanes (running/done phase)', () => {
  const stream = [
    { type: 'message' as const, text: 'Reading the ground truth first.' },
    { type: 'message' as const, text: 'Which environments do you want?' },
  ];

  it('running: two panes — the live checklist AND the embedded stream + working input', () => {
    const out = renderToStaticMarkup(
      <GuidedSetupPanes
        status={READY}
        actions={NOOP}
        events={stream}
        running={true}
        onFollowUp={() => {}}
        onFinishComplete={() => {}}
        onContinue={() => {}}
        followUpRef={{ current: null }}
      />,
    );
    // Left: a checklist row title. Right: the stream prose + the running header.
    expect(out).toContain('Git repository');
    expect(out).toContain('Reading the ground truth first.');
    expect(out).toContain('Setting things up…');
    // Follow-up input is disabled while working.
    expect(out).toContain('Agent is working…');
    // No done-phase footer CTA while running.
    expect(out).not.toContain('Continue setup');
    expect(out).not.toContain("You're set");
  });

  it('done + incomplete: shows the Continue setup CTA', () => {
    const out = renderToStaticMarkup(
      <GuidedSetupPanes
        status={READY}
        actions={NOOP}
        events={stream}
        running={false}
        onFollowUp={() => {}}
        onFinishComplete={() => {}}
        onContinue={() => {}}
        followUpRef={{ current: null }}
      />,
    );
    expect(out).toContain('Waiting on you');
    expect(out).toContain('Continue setup');
    expect(out).not.toContain("You're set");
  });

  it('done + failed: red header and a Try again CTA instead of Continue', () => {
    const out = renderToStaticMarkup(
      <GuidedSetupPanes
        status={READY}
        actions={NOOP}
        events={[{ type: 'error', text: 'codex exited with code 1' }]}
        running={false}
        failed={true}
        onFollowUp={() => {}}
        onFinishComplete={() => {}}
        onContinue={() => {}}
        onRetry={() => {}}
        followUpRef={{ current: null }}
      />,
    );
    expect(out).toContain('Setup hit a problem');
    expect(out).toContain('bg-destructive');
    expect(out).toContain('Try again');
    expect(out).not.toContain('Continue setup');
    expect(out).not.toContain('Setup complete');
  });

  it('failed with a backend at fault + another agent detected: CTA switches backend', () => {
    const out = renderToStaticMarkup(
      <GuidedSetupPanes
        status={READY}
        actions={NOOP}
        events={[{ type: 'error', text: 'model rejected (hint: your codex CLI may be too old…)' }]}
        running={false}
        failed={true}
        onFollowUp={() => {}}
        onFinishComplete={() => {}}
        onContinue={() => {}}
        onRetry={() => {}}
        retryAgent="claude"
        onRetryWith={() => {}}
        followUpRef={{ current: null }}
      />,
    );
    expect(out).toContain('Try again with Claude');
  });

  it('renders the auto-failover notice above the stream', () => {
    const out = renderToStaticMarkup(
      <GuidedSetupPanes
        status={READY}
        actions={NOOP}
        events={stream}
        running={true}
        notice="Codex failed to start — switched to Claude and retried automatically."
        onFollowUp={() => {}}
        onFinishComplete={() => {}}
        onContinue={() => {}}
        followUpRef={{ current: null }}
      />,
    );
    expect(out).toContain('switched to Claude and retried automatically');
  });

  it('done + complete: shows the "You\'re set" CTA', () => {
    const out = renderToStaticMarkup(
      <GuidedSetupPanes
        status={CONFIGURED}
        actions={NOOP}
        events={stream}
        running={false}
        onFollowUp={() => {}}
        onFinishComplete={() => {}}
        onContinue={() => {}}
        followUpRef={{ current: null }}
      />,
    );
    expect(out).toContain('ask the agent to build');
    expect(out).not.toContain('Continue setup');
  });
});
