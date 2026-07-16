import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleIcon,
  CopyIcon,
  LoaderCircleIcon,
  MinusCircleIcon,
  SparklesIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { EnvironmentsDialog } from './EnvironmentsDialog';
import { AgentStream } from './AgentStream';
import { useBuilderStore } from '../store/builderStore';
import type { SetupStatus } from '../store/setupClient';
import type { AgentEvent, AgentKind } from '../store/agentClient';
import {
  composeAnsweredSubset,
  extractGuidedQuestions,
  resolveGuidedAnswers,
  type GuidedAnswers,
  type GuidedQuestion,
} from '../lib/guidedQuestions';

const WELCOME_DISMISSED_KEY = 'emberflow.welcome.dismissed';
/** Set when the user chose "later" for environments in guided setup. */
const ENV_DEFERRED_KEY = 'emberflow.environments.deferred';
/** Re-run this exact command to (re)install the agent skills only. */
const SKILLS_INSTALL_COMMAND = 'npx emberflow init --local --no-launch';
/** Initialize a repo so agent changes can be snapshotted/reverted. */
const GIT_INIT_COMMAND = 'git init && git add -A && git commit -m "initial"';

const AGENT_LABELS: Record<AgentKind, string> = {
  codex: 'Codex',
  claude: 'Claude',
};

type RowStatus = 'complete' | 'incomplete' | 'unavailable';

function StatusGlyph({ status, emphasized }: { status: RowStatus; emphasized?: boolean }) {
  if (status === 'complete') {
    return <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success/80" aria-label="done" />;
  }
  if (status === 'unavailable') {
    return (
      <MinusCircleIcon
        className="mt-0.5 size-4 shrink-0 text-muted-foreground/30"
        aria-label="not yet available"
      />
    );
  }
  return (
    <CircleIcon
      className={`mt-0.5 size-4 shrink-0 ${emphasized ? 'text-highlight' : 'text-muted-foreground/50'}`}
      aria-label="to do"
    />
  );
}

/** Header fraction + 2px progress track. Quiet: mono numbers, ember fill. */
function Progress({ done, total }: { done: number; total: number }) {
  return (
    <div className="flex items-center gap-2.5" aria-label={`${done} of ${total} steps done`}>
      <div className="h-0.5 flex-1 overflow-hidden rounded-full bg-secondary/60">
        <div
          className="h-full rounded-full bg-highlight transition-[width] duration-300 ease-out motion-reduce:transition-none"
          style={{ width: `${total === 0 ? 0 : Math.round((done / total) * 100)}%` }}
        />
      </div>
      <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
        {done}/{total}
      </span>
    </div>
  );
}

/**
 * One checklist row. Completed rows compress to a single dim line (title +
 * inline action link) so the eye lands on what's left; the NEXT incomplete row
 * is emphasized (tinted, primary action). Everything stays reachable.
 */
function ChecklistRow({
  status,
  emphasized = false,
  title,
  detail,
  completedDetail,
  completedExtra,
  action,
  children,
}: {
  status: RowStatus;
  emphasized?: boolean;
  title: string;
  detail: string;
  completedDetail?: string;
  /** Replaces `completedDetail` in the compressed done row — e.g. the agent
   *  picker, which stays interactive even once the row is complete. */
  completedExtra?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  if (status === 'complete') {
    return (
      <div className="flex items-center gap-2.5 px-2.5 py-1.5">
        <StatusGlyph status={status} />
        <span className="text-[12px] text-muted-foreground">{title}</span>
        {completedExtra ?? (
          completedDetail ? (
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/60">
              {completedDetail}
            </span>
          ) : (
            <span className="flex-1" />
          )
        )}
        {action && <div className="shrink-0">{action}</div>}
      </div>
    );
  }
  return (
    <div
      className={`flex items-start gap-2.5 px-2.5 py-2.5 ${emphasized ? 'bg-highlight/[0.06]' : ''}`}
    >
      <StatusGlyph status={status} emphasized={emphasized} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[12.5px] font-medium leading-tight">{title}</span>
        <span className="text-[11px] leading-snug text-muted-foreground">{detail}</span>
        {children}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

/** Click-to-copy command pill. Shared: checklist rows here, and the
 *  StatusBar update chip's restart/manual-install commands. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title="Copy to clipboard"
      className="mt-0.5 flex items-center gap-2 self-start rounded-md border border-border bg-secondary/40 px-2 py-1 font-mono text-[11px] text-foreground/90 transition-colors hover:bg-secondary"
    >
      <code>{command}</code>
      {copied ? (
        <CheckIcon className="size-3 text-success" />
      ) : (
        <CopyIcon className="size-3 text-muted-foreground" />
      )}
    </button>
  );
}

export interface WelcomeChecklistActions {
  onOpenSettings: () => void;
  onSetupEnvironments: () => void;
  onOpenEnvironments: () => void;
  onOpenHelloOp: () => void;
  onScoutInfrastructure: () => void;
}

const NOOP_ACTIONS: WelcomeChecklistActions = {
  onOpenSettings: () => {},
  onSetupEnvironments: () => {},
  onOpenEnvironments: () => {},
  onOpenHelloOp: () => {},
  onScoutInfrastructure: () => {},
};

/**
 * Presentational checklist rendered from a resolved `/setup-status`. Split out
 * from the dialog wrapper (which owns fetch/open state) so it renders purely
 * from props — the component test drives it across fresh/configured/no-agent
 * states without a live runner.
 */
interface ChecklistItem {
  key: string;
  status: RowStatus;
  title: string;
  detail: string;
  completedDetail?: string;
  /** Label + handler for the row's action; the emphasized row's becomes primary. */
  actionLabel?: string;
  actionSparkle?: boolean;
  actionDisabled?: boolean;
  actionDisabledReason?: string;
  onAction?: () => void;
  extra?: 'skills-command' | 'manage-manually' | 'git-command';
}

/** Derive the checklist rows once — the dialog reuses this for its footer CTA.
 *  `chosenAgent` names the CONFIRMED backend: the agent row's detail shows only
 *  the one that will actually run (not every CLI detected) — the full choice
 *  lives in the picker / Settings. */
export function deriveChecklist(
  status: SetupStatus,
  actions: WelcomeChecklistActions,
  chosenAgent?: AgentKind,
): ChecklistItem[] {
  const { agents, git, environments, skills, ops, infrastructure } = status;
  const hasAgent = agents.length > 0;
  const hasGit = git.repo;
  const skillsInstalled = skills.claude || skills.codex;
  const activeAgent = agents.find((a) => a.kind === chosenAgent) ?? agents[0];
  const agentSummary = activeAgent
    ? `${activeAgent.kind}${activeAgent.version ? ` ${activeAgent.version}` : ''}`
    : '';

  return [
    {
      key: 'git',
      status: hasGit ? 'complete' : 'incomplete',
      title: 'Git repository',
      detail: 'Agent changes are snapshotted with git so you can review and revert them.',
      completedDetail: 'Repository ready',
      extra: hasGit ? undefined : 'git-command',
    },
    {
      key: 'agent',
      status: hasAgent ? 'complete' : 'incomplete',
      title: 'Coding agent',
      detail: 'None detected on PATH — install codex or claude to let the agent build for you.',
      completedDetail: agentSummary,
      actionLabel: 'Settings',
      onAction: actions.onOpenSettings,
    },
    // Skills sit with git + agent: all three are satisfied by `emberflow init`,
    // so a fresh install reads as a solid completed block at the top — the
    // remaining rows below are the journey still ahead. (No dependency forces
    // skills after environments; the old ordering just interleaved done/todo.)
    {
      key: 'skills',
      status: skillsInstalled ? 'complete' : 'incomplete',
      title: 'Agent skills',
      detail:
        'Installed automatically by emberflow init — this project doesn’t have them yet. Add them (skills only, nothing else changes):',
      completedDetail: 'Installed',
      extra: skillsInstalled ? undefined : 'skills-command',
    },
    {
      key: 'environments',
      // A deliberate "later" in guided setup TICKS the row (deferred) — the
      // user made a decision; an open circle would misread as blocked.
      status: environments.configured || environments.deferred ? 'complete' : 'incomplete',
      title: 'Environments',
      detail:
        "You're in Mock — nothing real is touched. Point runs at real systems when you're ready.",
      completedDetail: environments.configured
        ? `${environments.count} environment${environments.count === 1 ? '' : 's'}` +
          (environments.protectedCount > 0 ? `, ${environments.protectedCount} protected` : '')
        : 'Deferred — set up when ready',
      actionLabel: environments.configured ? 'Manage' : environments.deferred ? 'Set up' : 'Set up with AI',
      actionSparkle: !environments.configured && !environments.deferred,
      // The "Set up with AI" action drives the coding agent, which needs both
      // an agent on PATH and a git repo to snapshot against — gate it the same
      // way scout is gated. Git is the earlier prerequisite, so its reason
      // wins when both are missing.
      actionDisabled: !environments.configured && (!hasGit || !hasAgent),
      actionDisabledReason: !hasGit ? 'Initialize git first' : 'Detect a coding agent first',
      onAction: environments.configured ? actions.onOpenEnvironments : actions.onSetupEnvironments,
      extra: environments.configured || environments.deferred ? undefined : 'manage-manually',
    },
    // NOTE: secrets & auth deliberately have no checklist row — they only
    // matter once an operation touches real infrastructure, and they live in
    // the Manage Environment dialog when that day comes. Surfacing them at
    // onboarding was premature noise.
    {
      key: 'infrastructure',
      status: infrastructure.present ? 'complete' : 'incomplete',
      title: 'Project scanned',
      detail: 'The agent scans this project for databases, APIs and providers it already uses.',
      completedDetail: `${infrastructure.itemCount ?? 0} item${infrastructure.itemCount === 1 ? '' : 's'} found`,
      actionLabel: 'Scout',
      actionSparkle: true,
      // Scout drives the coding agent, which needs both an agent on PATH and a
      // git repo to snapshot against. Git is the earlier prerequisite, so its
      // reason wins when both are missing.
      actionDisabled: !hasGit || !hasAgent,
      actionDisabledReason: !hasGit ? 'Initialize git first' : 'Detect a coding agent first',
      onAction: actions.onScoutInfrastructure,
    },
    {
      key: 'first-op',
      status: ops.count > 1 ? 'complete' : 'incomplete',
      title: 'First operation',
      detail: 'Open the hello example to see how an operation is built — then run it.',
      completedDetail: `${ops.count} operations`,
      actionLabel: 'Open hello op',
      onAction: actions.onOpenHelloOp,
    },
  ];
}

/** First incomplete row = the step we pull the user toward. */
export const nextStepIndex = (items: ChecklistItem[]) =>
  items.findIndex((i) => i.status === 'incomplete');

/** Inline codex/claude choice chips — shared by the checklist's agent row and
 *  the guided card (where they must stay reachable while the checklist is
 *  collapsed behind the manual disclosure). */
function AgentPickerChips({
  agents,
  activeAgent,
  onChoose,
}: {
  agents: SetupStatus['agents'];
  activeAgent?: AgentKind;
  onChoose: (kind: AgentKind) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap gap-1" role="group" aria-label="Choose coding agent">
      {agents.map(({ kind, version }) => (
        <button
          key={kind}
          type="button"
          onClick={() => onChoose(kind)}
          aria-pressed={activeAgent === kind}
          className={cn(
            'cursor-pointer rounded-md border px-2 py-0.5 text-[11px] transition-colors',
            activeAgent === kind
              ? 'border-ring bg-secondary/60 font-medium text-foreground'
              : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          {AGENT_LABELS[kind]}
          {version ? <span className="ml-1 font-normal text-muted-foreground">{version}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function WelcomeChecklist({
  status,
  actions = NOOP_ACTIONS,
  chosenAgent,
  onChooseAgent,
  showProgress = true,
}: {
  status: SetupStatus;
  actions?: WelcomeChecklistActions;
  /** The user's preferred agent (from Settings); defaults to the first detected. */
  chosenAgent?: AgentKind;
  onChooseAgent?: (kind: AgentKind) => void;
  /** The idle screen renders its own top-level progress bar — suppress this one there. */
  showProgress?: boolean;
}) {
  const items = deriveChecklist(status, actions, chosenAgent);
  const done = items.filter((i) => i.status === 'complete').length;
  const nextIdx = nextStepIndex(items);

  // With more than one agent CLI on PATH the agent row becomes a choice, not a
  // fact: an inline picker replaces the compressed summary and stays live.
  const multipleAgents = status.agents.length > 1 && onChooseAgent !== undefined;
  const activeAgent = chosenAgent ?? status.agents[0]?.kind;
  const agentPicker = multipleAgents ? (
    <AgentPickerChips agents={status.agents} activeAgent={activeAgent} onChoose={onChooseAgent} />
  ) : undefined;

  return (
    <div className="space-y-3">
      {showProgress && <Progress done={done} total={items.length} />}
      <div className="divide-y divide-border/50 rounded-md border border-border/70">
        {items.map((item, i) => {
          const emphasized = i === nextIdx;
          return (
            <ChecklistRow
              key={item.key}
              status={item.status}
              emphasized={emphasized}
              title={item.title}
              detail={item.detail}
              completedDetail={item.completedDetail}
              completedExtra={item.key === 'agent' ? agentPicker : undefined}
              action={
                item.actionLabel && item.onAction ? (
                  item.status === 'complete' ? (
                    <button
                      type="button"
                      onClick={item.onAction}
                      className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      {item.actionLabel}
                    </button>
                  ) : (
                    <Button
                      variant={emphasized ? 'default' : 'outline'}
                      size="sm"
                      disabled={item.actionDisabled}
                      title={item.actionDisabled ? item.actionDisabledReason : undefined}
                      onClick={item.onAction}
                    >
                      {item.actionSparkle && <SparklesIcon className="size-3.5" />}
                      {item.actionLabel}
                    </Button>
                  )
                ) : undefined
              }
            >
              {item.status !== 'complete' && item.extra === 'git-command' && (
                <CopyCommand command={GIT_INIT_COMMAND} />
              )}
              {item.status !== 'complete' && item.extra === 'skills-command' && (
                <CopyCommand command={SKILLS_INSTALL_COMMAND} />
              )}
              {item.status !== 'complete' && item.extra === 'manage-manually' && (
                <button
                  type="button"
                  onClick={actions.onOpenEnvironments}
                  className="self-start text-[10.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Manage manually
                </button>
              )}
            </ChecklistRow>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Footer: the primary CTA mirrors the NEXT incomplete step (same handler as the
 * emphasized row), so the strongest affordance always advances setup. All
 * steps done → pull toward the real aha: building the first API.
 * "Don't show again" is the true dismissal (records the flag).
 */
function WelcomeFooter({
  status,
  actions,
  onDismiss,
  manualOpen,
  onToggleManual,
}: {
  status: SetupStatus | null;
  actions: WelcomeChecklistActions;
  onDismiss: () => void;
  manualOpen?: boolean;
  onToggleManual?: () => void;
}) {
  const setCreateModal = useBuilderStore((s) => s.setCreateModal);
  const setWelcomeOpen = useBuilderStore((s) => s.setWelcomeOpen);
  const items = status ? deriveChecklist(status, actions) : [];
  const nextIdx = status ? nextStepIndex(items) : -1;
  const next = nextIdx === -1 ? undefined : items[nextIdx];

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={onDismiss}
          className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Don't show this again
        </button>
        {onToggleManual && (
          <button
            type="button"
            onClick={onToggleManual}
            aria-expanded={manualOpen}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {manualOpen ? 'Hide manual steps' : 'Set up manually instead'}
          </button>
        )}
      </div>
      {/* The emphasized row owns the next-step primary; the footer only takes
          over once everything is done — pulling toward the real aha. One door:
          the create modal. */}
      {status && !next && (
        <Button
          size="sm"
          onClick={() => {
            setWelcomeOpen(false);
            setCreateModal({ mode: 'api' });
          }}
        >
          <SparklesIcon className="size-3.5" />
          You're set — build your first API
        </Button>
      )}
    </div>
  );
}

/**
 * The Start-setup gate + summary, derived from the SAME checklist state the rows
 * use. `remaining` names what the one guided run will work through (skipping
 * anything already done); git + a coding agent are the two prerequisites the
 * user must satisfy manually, so their absence disables Start with a reason.
 */
function guidedStartState(status: SetupStatus): {
  remaining: string[];
  disabled: boolean;
  disabledReason?: string;
} {
  const hasAgent = status.agents.length > 0;
  const hasGit = status.git.repo;
  const skillsInstalled = status.skills.claude || status.skills.codex;

  const remaining: string[] = [];
  if (!status.infrastructure.present) remaining.push('Scan your code for existing infrastructure');
  if (!status.environments.configured && !status.environments.deferred)
    remaining.push('Set up environments — it asks you a few questions');
  if (!skillsInstalled) remaining.push('Install the agent skills');
  remaining.push('Verify the skills and its own connection');

  return {
    remaining,
    disabled: !hasGit || !hasAgent,
    // Git is the earlier prerequisite, so its reason wins when both are missing
    // (mirrors the scout/environments row gating).
    disabledReason: !hasGit ? 'Initialize git first' : !hasAgent ? 'Detect a coding agent first' : undefined,
  };
}

/**
 * idle-phase primary block: "Let the agent set this up." A short summary of what
 * the one run will do (from `guidedStartState`) plus the Start-setup CTA. Sits
 * ABOVE the manual checklist — the guided path is primary, the rows stay as the
 * manual fallback.
 */
export function GuidedSetupIntro({
  status,
  chosenAgent,
  onChooseAgent,
  onStart,
}: {
  status: SetupStatus;
  chosenAgent?: AgentKind;
  onChooseAgent?: (kind: AgentKind) => void;
  onStart: () => void;
}) {
  const { remaining, disabled, disabledReason } = guidedStartState(status);
  const multipleAgents = status.agents.length > 1 && onChooseAgent !== undefined;
  const activeAgent = chosenAgent ?? status.agents[0]?.kind;
  return (
    <div className="rounded-md border border-highlight/30 bg-highlight/[0.06] p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-highlight/15 text-highlight">
          <SparklesIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium leading-tight">Let the agent set this up</div>
          <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">
            One run finishes setup — it reads what's already done and skips it.
          </p>
          {/* The steps the run will work through: the same rows that tick live
              in the two-pane view once started — the list IS the plan. */}
          <ul className="mt-2.5 space-y-1.5">
            {remaining.map((step) => (
              <li key={step} className="flex items-center gap-2 text-[11.5px] text-foreground/85">
                <CircleIcon className="size-3.5 shrink-0 text-highlight/60" aria-hidden />
                {step}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="mt-3.5 flex items-center justify-between gap-3">
        {multipleAgents ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[10.5px] text-muted-foreground">Runs with</span>
            <AgentPickerChips agents={status.agents} activeAgent={activeAgent} onChoose={onChooseAgent} />
          </div>
        ) : (
          <span />
        )}
        <Button
          size="sm"
          className="shrink-0"
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
          onClick={onStart}
        >
          <SparklesIcon className="size-3.5" />
          Start setup
        </Button>
      </div>
      {disabled && disabledReason && (
        <p className="mt-1.5 text-right text-[10.5px] text-muted-foreground/70">{disabledReason}</p>
      )}
    </div>
  );
}

/**
 * Read-only checklist for the guided two-pane view: while the agent works
 * through setup, the left pane is a quiet progress MAP — glyph + title +
 * completed detail, one line per step. No buttons: the interactive actions
 * (Set up with AI, Scout, …) are exactly what the agent is doing, and
 * clicking them mid-run would just collide with the single-flight run.
 */
export function GuidedChecklistMap({
  status,
  running,
  chosenAgent,
}: {
  status: SetupStatus;
  running?: boolean;
  chosenAgent?: AgentKind;
}) {
  const items = deriveChecklist(status, NOOP_ACTIONS, chosenAgent);
  const done = items.filter((i) => i.status === 'complete').length;
  const nextIdx = nextStepIndex(items);
  // Entrance beat: rows already complete when the panes open tick in one after
  // another (staggered scale/fade) — a quick "these are done, done, done" that
  // earns the green block instead of it just sitting there. One-shot on mount;
  // rows completing LIVE later render instantly (revealed stays true).
  // prefers-reduced-motion: the transition is suppressed, checks just appear.
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div className="space-y-3">
      <Progress done={done} total={items.length} />
      <div className="space-y-0.5">
        {items.map((item, i) => (
          <div
            key={item.key}
            className={cn(
              'flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5',
              i === nextIdx && 'bg-highlight/[0.06]',
            )}
          >
            {/* While the agent runs, the NEXT step is the one being worked on —
                its glyph becomes a spinner so the left map shows live activity.
                Reduced motion: the spin stops but the ember ring still marks it. */}
            {running && i === nextIdx ? (
              <LoaderCircleIcon
                className="mt-0.5 size-4 shrink-0 animate-spin text-highlight motion-reduce:animate-none"
                aria-label="in progress"
              />
            ) : item.status === 'complete' ? (
              <span
                className={cn(
                  'transition-all duration-300 ease-out motion-reduce:transition-none',
                  revealed ? 'scale-100 opacity-100' : 'scale-50 opacity-0',
                )}
                style={{ transitionDelay: `${i * 140}ms` }}
              >
                <StatusGlyph status="complete" />
              </span>
            ) : (
              <StatusGlyph status={item.status} emphasized={i === nextIdx} />
            )}
            <span
              className={cn(
                'shrink-0 text-[12px]',
                item.status === 'complete'
                  ? 'text-muted-foreground'
                  : i === nextIdx
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground',
              )}
            >
              {item.title}
            </span>
            {item.status === 'complete' && item.completedDetail && (
              <span className="min-w-0 truncate text-[11px] text-muted-foreground/60">
                {item.completedDetail}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One dim line acknowledging what's already in place — proof of progress
 *  without a row (and a button) per item. */
export function DoneSummary({ status, chosenAgent }: { status: SetupStatus; chosenAgent?: AgentKind }) {
  const items = deriveChecklist(status, NOOP_ACTIONS, chosenAgent).filter((i) => i.status === 'complete');
  if (items.length === 0) return null;
  return (
    <div className="flex items-center gap-2 px-0.5 text-[11px] text-muted-foreground">
      <CheckCircle2Icon className="size-3.5 shrink-0 text-success/70" aria-label="done" />
      <span className="min-w-0 truncate">
        {items.map((i) => (i.key === 'agent' ? i.completedDetail || i.title : i.title)).join(' · ')}
      </span>
    </div>
  );
}

/**
 * A slim follow-up input pinned under the embedded stream: answers the agent's
 * questions by sending another guided-setup run (same panel thread). Disabled
 * while the run is working. `focusRef` lets the done-phase "Continue setup" CTA
 * pull focus here.
 */
function GuidedFollowUp({
  running,
  onSend,
  focusRef,
}: {
  running: boolean;
  onSend: (text: string) => void;
  focusRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [text, setText] = useState('');
  const send = () => {
    const t = text.trim();
    if (!t || running) return;
    onSend(t);
    setText('');
  };
  return (
    <div className="shrink-0 border-t border-border/70 p-2.5">
      <div className="flex items-end gap-2">
        <textarea
          ref={focusRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              send();
            }
          }}
          disabled={running}
          placeholder={running ? 'Agent is working…' : 'Answer the agent’s questions…'}
          rows={2}
          className="min-h-0 flex-1 resize-none rounded-md border border-input bg-input/30 px-2.5 py-1.5 text-[12px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
        />
        <Button
          size="icon"
          className="size-8 shrink-0"
          onClick={send}
          disabled={running || !text.trim()}
          aria-label="Send to agent"
          title="Send (⌘⏎)"
        >
          <ArrowUpIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * The agent's trailing `emberflow-questions` block rendered as a clickable
 * form (replacing the follow-up textarea while the run waits on answers).
 * Single-select pills per question — the same chip vocabulary as the agent
 * picker — plus an optional "Other…" free-text field that deselects the pills.
 * Submit composes plaintext answers for the continuation run; an option with
 * action 'finish' ends onboarding instead (`onFinish`), sending nothing; a
 * lone typed 'first-build' answer routes into the create flow (`onBuild`).
 */
function GuidedQuestionForm({
  questions,
  onSubmit,
  onFinish,
  onBuild,
  onDefer,
  onTypeInstead,
}: {
  questions: GuidedQuestion[];
  onSubmit: (composed: string) => void;
  onFinish: () => void;
  onBuild: (text: string) => void;
  /** A chosen option carried `defers: <topic>` — tick that checklist topic. */
  onDefer?: (topic: string) => void;
  onTypeInstead: () => void;
}) {
  const [answers, setAnswers] = useState<GuidedAnswers>({});
  // Wizard: ONE question at a time — picking an option answers it and
  // advances; the last answer reveals Send. `cursor` never exceeds the last
  // question; Back steps to any earlier answer without losing later ones.
  const [cursor, setCursor] = useState(0);
  const outcome = resolveGuidedAnswers(questions, answers);
  const q = questions[Math.min(cursor, questions.length - 1)];
  const answer = answers[q.id];
  const last = cursor >= questions.length - 1;
  const advance = () => setCursor((c) => Math.min(c + 1, questions.length - 1));
  const submit = () => {
    if (outcome.kind === 'finish') onFinish();
    else if (outcome.kind === 'build') onBuild(outcome.text);
    else if (outcome.kind === 'send') onSubmit(outcome.text);
  };
  // The form sits at the bottom of a busy scrolling column — pull it into view
  // whenever a (new) set of questions appears so the ask is never missed.
  // (Effects don't run under renderToStaticMarkup; ref + method are guarded.)
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    cardRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [questions]);
  return (
    <div
      ref={cardRef}
      className="m-2.5 shrink-0 space-y-3 rounded-md border border-highlight/40 bg-highlight/[0.07] p-3.5"
    >
      {/* Unmistakable ask: ember dot + label, the same treatment as the guided
          intro card — this is a question, not more stream chrome. */}
      <div className="flex items-center gap-2">
        <span
          className="size-2 rounded-full bg-highlight animate-pulse motion-reduce:animate-none"
          aria-hidden
        />
        <span className="text-[11px] font-medium uppercase tracking-wide text-highlight">
          Your answer needed
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[13.5px] font-medium leading-snug">{q.text}</div>
        {questions.length > 1 && (
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
            {cursor + 1}/{questions.length}
          </span>
        )}
      </div>
      {q.why && (
        <p className="max-w-[65ch] text-[11.5px] leading-snug text-muted-foreground">{q.why}</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={q.text}>
        {q.options.map((opt) => {
          const selected = answer?.option?.label === opt.label;
          return (
            <button
              key={opt.label}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                const next: GuidedAnswers = { ...answers, [q.id]: { option: opt } };
                setAnswers(next);
                // A deferring option ticks its checklist topic client-side.
                if (opt.defers) onDefer?.(opt.defers);
                // A 'submit' option sends IMMEDIATELY with whatever has been
                // answered so far — a subset; unanswered questions are skipped.
                if (opt.action === 'submit') onSubmit(composeAnsweredSubset(questions, next));
                else if (!last) advance();
              }}
              className={cn(
                // On the ember-tinted ask-card, hairline borders wash out — the
                // options need real button weight (solid surface + shadow, the
                // app's outline-button vocabulary) to read as pressable.
                'cursor-pointer rounded-md border px-3 py-1.5 text-[12.5px] shadow-sm transition-colors',
                selected
                  ? 'border-ring bg-secondary font-medium text-foreground'
                  : 'border-border bg-card text-foreground hover:border-ring/60 hover:bg-secondary/60',
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {q.custom && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={answer?.text ?? ''}
            onChange={(e) =>
              // Typing a custom answer deselects the pills for this question.
              setAnswers((a) => ({ ...a, [q.id]: { text: e.target.value } }))
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (answer?.text ?? '').trim()) {
                e.preventDefault();
                if (last) submit();
                else advance();
              }
            }}
            placeholder="Or type your own…"
            aria-label={`${q.text} — other`}
            className={cn(
              // A visibly RECESSED well (darker than the tinted card, inset
              // shadow) so it reads as "type here", distinct from the raised
              // option buttons above it.
              'min-w-0 flex-1 rounded-md border border-input bg-background/60 px-2.5 py-1.5 text-[12.5px] text-foreground shadow-inner outline-none transition-colors placeholder:italic placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
            )}
          />
          {!last && (answer?.text ?? '').trim() !== '' && (
            <Button size="sm" variant="outline" onClick={advance}>
              Next
            </Button>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {cursor > 0 && (
            <button
              type="button"
              onClick={() => setCursor((c) => Math.max(0, c - 1))}
              className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={onTypeInstead}
            className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Type a reply instead
          </button>
        </div>
        {(last || outcome.kind !== 'incomplete') && (
          <Button size="sm" onClick={submit} disabled={outcome.kind === 'incomplete'}>
            Send answers
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * running/done phase: two panes. LEFT the live checklist (refetched on run
 * finish by the dialog), RIGHT the embedded agent stream + follow-up input.
 * `done` swaps the footer: everything complete → "You're set", else "Continue
 * setup" focuses the follow-up so the interview can continue.
 */
export function GuidedSetupPanes({
  status,
  actions,
  chosenAgent,
  events,
  running,
  failed,
  onFollowUp,
  onFinishComplete,
  onBuildFirst,
  onDefer,
  onContinue,
  onRetry,
  retryAgent,
  onRetryWith,
  notice,
  followUpRef,
}: {
  status: SetupStatus | null;
  actions: WelcomeChecklistActions;
  /** The confirmed backend — the checklist's agent row shows only this one. */
  chosenAgent?: AgentKind;
  events: React.ComponentProps<typeof AgentStream>['events'];
  running: boolean;
  /** The guided run ended on an error event (agent crashed / model rejected). */
  failed?: boolean;
  onFollowUp: (text: string) => void;
  onFinishComplete: () => void;
  /** The lone 'first-build' question answered with a typed description —
   *  open the real build flow pre-filled instead of sending a continuation.
   *  Falls back to `onFollowUp` (send) when not provided. */
  onBuildFirst?: (text: string) => void;
  /** A chosen question option carried `defers: <topic>`. */
  onDefer?: (topic: string) => void;
  onContinue: () => void;
  /** Re-kick the guided run after a failure. */
  onRetry?: () => void;
  /** When the failure was the BACKEND's fault (e.g. a stale CLI rejecting its
   *  model) and another agent is detected, retry switches to it — plain
   *  "Try again" would just replay the same broken backend. */
  retryAgent?: AgentKind;
  onRetryWith?: (kind: AgentKind) => void;
  /** One-line explanation when the dialog auto-switched backend after a failure. */
  notice?: string;
  followUpRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const allDone = status ? nextStepIndex(deriveChecklist(status, actions)) === -1 : false;

  // The agent's final message may end with an `emberflow-questions` block —
  // pull it out here (pure derivation over the event stream) so the stream
  // renders the prose WITHOUT the raw fenced JSON and the block becomes the
  // clickable form below. Malformed blocks extract as null and pass through
  // untouched.
  const { displayEvents, questions } = useMemo((): {
    displayEvents: AgentEvent[];
    questions: GuidedQuestion[] | null;
  } => {
    const idx = events.findLastIndex((e) => e.type === 'message');
    if (idx === -1) return { displayEvents: events, questions: null };
    const { stripped, questions: extracted } = extractGuidedQuestions(events[idx].text ?? '');
    if (!extracted) return { displayEvents: events, questions: null };
    const copy = events.slice();
    copy[idx] = { ...copy[idx], text: stripped };
    return { displayEvents: copy, questions: extracted };
  }, [events]);

  // "Type a reply instead" swaps the form for the plain textarea; a fresh set
  // of questions (next agent turn) resets back to the form.
  const [typedReply, setTypedReply] = useState(false);
  useEffect(() => setTypedReply(false), [questions]);

  // Declutter: only the TAIL of the stream — the LAST agent message onward
  // (plus any trailing commands/errors) — renders by default; everything
  // before it folds behind a quiet "Earlier setup activity" disclosure. The
  // open state is keyed by the fold boundary, so a NEW agent message
  // re-collapses the history automatically. Fewer than two messages → no fold.
  // (⚠-prefixed diagnostics are noise, not prose — they never anchor the fold.)
  const foldIdx = useMemo(() => {
    const msgIdxs = displayEvents
      .map((e, i) => (e.type === 'message' && !(e.text ?? '').startsWith('⚠') ? i : -1))
      .filter((i) => i >= 0);
    return msgIdxs.length >= 2 ? msgIdxs[msgIdxs.length - 1] : -1;
  }, [displayEvents]);
  const [expandedAt, setExpandedAt] = useState(-1);
  const foldOpen = foldIdx !== -1 && expandedAt === foldIdx;
  const earlierEvents = foldIdx === -1 ? [] : displayEvents.slice(0, foldIdx);
  const tailEvents = foldIdx === -1 ? displayEvents : displayEvents.slice(foldIdx);

  const showForm = !running && !failed && questions !== null && !typedReply;
  const headerText = running
    ? 'Setting things up…'
    : failed
      ? 'Setup hit a problem'
      : allDone
        ? 'Setup complete'
        : 'Waiting on you';
  return (
    <div className="grid min-h-0 grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div className="min-h-0 overflow-y-auto">
        {status ? (
          <GuidedChecklistMap status={status} running={running} chosenAgent={chosenAgent} />
        ) : (
          <div className="py-6 text-center text-[12px] text-muted-foreground">Checking your project…</div>
        )}
      </div>
      <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border/70 bg-card">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
          <span
            className={cn(
              'size-2 rounded-full',
              running ? 'animate-pulse bg-highlight' : failed ? 'bg-destructive' : 'bg-success',
            )}
          />
          <span className="text-[11.5px] font-medium">{headerText}</span>
        </div>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-2.5 text-[12px]">
          {notice && <div className="text-[11px] text-highlight/90">{notice}</div>}
          {foldIdx !== -1 && (
            <button
              type="button"
              aria-expanded={foldOpen}
              onClick={() => setExpandedAt(foldOpen ? -1 : foldIdx)}
              className="block text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {foldOpen
                ? '▾ Earlier setup activity'
                : `▸ Earlier setup activity (${earlierEvents.length} update${earlierEvents.length === 1 ? '' : 's'})`}
            </button>
          )}
          {foldOpen && <AgentStream events={earlierEvents} running={false} />}
          <AgentStream events={tailEvents} running={running} />
        </div>
        {showForm && questions ? (
          <GuidedQuestionForm
            questions={questions}
            onSubmit={onFollowUp}
            onFinish={onFinishComplete}
            onBuild={onBuildFirst ?? onFollowUp}
            onDefer={onDefer}
            onTypeInstead={() => setTypedReply(true)}
          />
        ) : (
          <>
            <GuidedFollowUp running={running} onSend={onFollowUp} focusRef={followUpRef} />
            {!running && !failed && questions !== null && typedReply && (
              <div className="shrink-0 px-2.5 pb-2">
                <button
                  type="button"
                  onClick={() => setTypedReply(false)}
                  className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Answer with the options instead
                </button>
              </div>
            )}
          </>
        )}
        {/* When the question form is up, the "Continue setup" nudge is redundant
            — the form IS the continuation — so the footer only renders for the
            failed / all-done / plain-textarea states. */}
        {!running && (failed || allDone || questions === null) && (
          <div className="flex shrink-0 justify-end border-t border-border/70 px-2.5 py-2">
            {failed ? (
              retryAgent && onRetryWith ? (
                <Button size="sm" onClick={() => onRetryWith(retryAgent)}>
                  Try again with {AGENT_LABELS[retryAgent]}
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={onRetry}>
                  Try again
                </Button>
              )
            ) : allDone ? (
              <Button size="sm" onClick={onFinishComplete}>
                <SparklesIcon className="size-3.5" />
                You're set — build your first API
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={onContinue}>
                Continue setup
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * First-run Welcome/Setup dialog. Mounted once (in the Toolbar). Fetches
 * `/setup-status` on mount to decide whether to auto-open on a fresh project,
 * and again whenever it's opened so the rows reflect the latest state. Always
 * reachable from the StatusBar's setup chip (via the store's `welcomeOpen`).
 *
 * Grows a `idle → running → done` guided phase machine on top of the checklist:
 * Start setup kicks ONE `guided-setup` agent run (owned here, not the right-hand
 * console), whose stream embeds in a two-pane layout. Closing the dialog mid-run
 * doesn't kill it — the run lives in the store's single agentRun slot, so
 * reopening re-attaches (phase derives from `agentRun.guided` + status).
 */
export function WelcomeDialog() {
  const welcomeOpen = useBuilderStore((s) => s.welcomeOpen);
  const setWelcomeOpen = useBuilderStore((s) => s.setWelcomeOpen);
  const openSettingsFromWelcome = useBuilderStore((s) => s.openSettingsFromWelcome);
  const beginEnvironmentSetup = useBuilderStore((s) => s.beginEnvironmentSetup);
  const beginInfrastructureScout = useBuilderStore((s) => s.beginInfrastructureScout);
  const switchWorkflow = useBuilderStore((s) => s.switchWorkflow);
  const status = useBuilderStore((s) => s.setupStatus);
  const refreshSetupStatus = useBuilderStore((s) => s.refreshSetupStatus);
  const agentChoice = useBuilderStore((s) => s.agentChoice);
  const setAgentChoice = useBuilderStore((s) => s.setAgentChoice);
  const beginGuidedSetup = useBuilderStore((s) => s.beginGuidedSetup);
  const setCreateModal = useBuilderStore((s) => s.setCreateModal);
  const agentRun = useBuilderStore((s) => s.agentRun);
  const guidedTranscript = useBuilderStore((s) => s.guidedTranscript);
  const [envDialogOpen, setEnvDialogOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const followUpRef = useRef<HTMLTextAreaElement | null>(null);

  // "Later" in the guided interview DEFERS environments: the checklist row
  // ticks (deferred, not blocked). Persisted so a reload doesn't un-decide it;
  // cleared automatically once environments are actually configured.
  const [envDeferred, setEnvDeferred] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(ENV_DEFERRED_KEY) === '1',
  );
  const deferTopic = (topic: string) => {
    if (topic !== 'environments') return;
    setEnvDeferred(true);
    if (typeof localStorage !== 'undefined') localStorage.setItem(ENV_DEFERRED_KEY, '1');
  };
  useEffect(() => {
    if (status?.environments.configured && envDeferred) {
      setEnvDeferred(false);
      if (typeof localStorage !== 'undefined') localStorage.removeItem(ENV_DEFERRED_KEY);
    }
  }, [status?.environments.configured, envDeferred]);
  // Every checklist consumer below reads the AUGMENTED status.
  const effectiveStatus: SetupStatus | null =
    status && envDeferred && !status.environments.configured
      ? { ...status, environments: { ...status.environments, deferred: true } }
      : status;

  // Guided phase: derived from the single agentRun slot. `guided` marks the run
  // this dialog owns, so closing + reopening re-attaches to the same stream.
  const guidedRun = agentRun?.guided ? agentRun : null;
  const phase: 'idle' | 'running' | 'done' = !guidedRun
    ? 'idle'
    : guidedRun.status === 'running'
      ? 'running'
      : 'done';

  // A failed run whose terminal error blames the BACKEND (stale CLI rejected
  // its model, or the process died) offers a one-click switch to the other
  // detected agent — a plain retry would replay the same broken backend.
  const activeAgent = agentChoice.agent ?? status?.agents[0]?.kind;
  const lastError = guidedRun?.status === 'error'
    ? [...guidedRun.events].reverse().find((e) => e.type === 'error')?.text ?? ''
    : '';
  const backendFault = /CLI may be too old|exited with code/i.test(lastError);
  const retryAgent = backendFault
    ? status?.agents.find((a) => a.kind !== activeAgent)?.kind
    : undefined;

  const guidedStatus = guidedRun?.status;

  // Auto-failover, once: a backend-fault failure with another agent available
  // switches to it and re-kicks the run WITHOUT waiting for a click — the
  // default backend being broken (stale codex CLI) shouldn't strand setup on
  // an error pane. One-shot per dialog mount so two broken backends can't
  // ping-pong; the manual "Try again with X" stays as the fallback.
  const autoFailoverUsed = useRef(false);
  const [autoSwitchNotice, setAutoSwitchNotice] = useState<string | null>(null);
  useEffect(() => {
    if (guidedStatus !== 'error' || !retryAgent || autoFailoverUsed.current) return;
    autoFailoverUsed.current = true;
    const from = activeAgent ? AGENT_LABELS[activeAgent] : 'The agent';
    setAutoSwitchNotice(`${from} failed to start — switched to ${AGENT_LABELS[retryAgent]} and retried automatically.`);
    setAgentChoice({ ...agentChoice, agent: retryAgent });
    beginGuidedSetup();
    // agentChoice/activeAgent are read at fire time; keying on them would re-arm the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guidedStatus, retryAgent]);

  // While the guided run is live, poll the checklist every few seconds: the
  // agent writes ground-truth files mid-turn (emberflow.environments.json, the
  // scout output), so the left map should tick rows green AS they land, not
  // only when the run ends. deriveChecklist recomputes per render and the
  // spinner already sits on the next incomplete row, so a refetch is all it
  // takes. (Interval effect — not covered by the static-markup tests.)
  useEffect(() => {
    if (phase !== 'running') return;
    const id = setInterval(() => void refreshSetupStatus(), 4000);
    return () => clearInterval(id);
  }, [phase, refreshSetupStatus]);

  // Refetch the checklist when the guided run finishes (a completed run may have
  // scouted, installed skills, or written environments) — mirrors the
  // agentRunStatus subscription StatusBar/InfraTab use.
  useEffect(() => {
    if (!guidedStatus || guidedStatus === 'running') return;
    void refreshSetupStatus();
  }, [guidedStatus, refreshSetupStatus]);

  // Mount: fetch once and auto-open on a fresh, undismissed project.
  useEffect(() => {
    let cancelled = false;
    void refreshSetupStatus().then((s) => {
      if (cancelled || !s) return;
      const dismissed =
        typeof localStorage !== 'undefined' && localStorage.getItem(WELCOME_DISMISSED_KEY) === '1';
      if (s.ops.onlyHello && !s.environments.configured && !dismissed) {
        setWelcomeOpen(true);
      }
    });
    return () => {
      cancelled = true;
    };
    // Mount-only: auto-open is a one-shot boot decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Opening the dialog must land on the IDLE intro (Start setup) unless the
  // guided run is live or still waiting on an answer — auto-resuming a stale
  // finished stream read as "it started by itself". Pending questions in the
  // last message keep the two-pane so the interview can be answered.
  const resetGuidedSetup = useBuilderStore((s) => s.resetGuidedSetup);
  useEffect(() => {
    if (!welcomeOpen || !guidedRun || guidedRun.status === 'running') return;
    const lastMsg = [...guidedRun.events].reverse().find((e) => e.type === 'message');
    const pending = lastMsg?.text ? extractGuidedQuestions(lastMsg.text).questions : null;
    if (!pending) resetGuidedSetup();
    // Run only on open transitions — the run object identity churns per event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [welcomeOpen]);

  // Refresh the rows every time the dialog opens (e.g. from the StatusBar chip).
  useEffect(() => {
    if (!welcomeOpen) return;
    void refreshSetupStatus();
  }, [welcomeOpen, refreshSetupStatus]);

  /** A user-driven close (X / overlay / esc / Dismiss) records the dismissal so
   *  the dialog never auto-opens again; navigational actions close without it. */
  const dismiss = () => {
    setWelcomeOpen(false);
    if (typeof localStorage !== 'undefined') localStorage.setItem(WELCOME_DISMISSED_KEY, '1');
  };

  const actions: WelcomeChecklistActions = {
    onOpenSettings: openSettingsFromWelcome,
    onSetupEnvironments: () => {
      setWelcomeOpen(false);
      beginEnvironmentSetup();
    },
    onOpenEnvironments: () => {
      setWelcomeOpen(false);
      setEnvDialogOpen(true);
    },
    onOpenHelloOp: () => {
      setWelcomeOpen(false);
      switchWorkflow('default/hello');
    },
    onScoutInfrastructure: () => {
      setWelcomeOpen(false);
      beginInfrastructureScout();
    },
  };

  const twoPane = phase !== 'idle';

  return (
    <>
      <Dialog open={welcomeOpen} onOpenChange={(o) => (o ? setWelcomeOpen(true) : dismiss())}>
        <DialogContent className={cn('flex max-h-[85vh] flex-col', twoPane ? 'max-w-3xl' : 'max-w-lg')}>
          <DialogTitle>Welcome to Emberflow</DialogTitle>
          <DialogDescription>
            {twoPane
              ? 'The agent is working through setup — answer its questions on the right; the checklist updates as it goes.'
              : 'Get this project ready to build and run — revisit any time from the setup chip in the status bar.'}
          </DialogDescription>
          {twoPane ? (
            <GuidedSetupPanes
              status={effectiveStatus}
              actions={actions}
              chosenAgent={agentChoice.agent}
              events={[...guidedTranscript, ...(guidedRun?.events ?? [])]}
              running={phase === 'running'}
              failed={guidedRun?.status === 'error'}
              onRetry={() => beginGuidedSetup()}
              retryAgent={retryAgent}
              onRetryWith={(kind) => {
                setAgentChoice({ ...agentChoice, agent: kind });
                beginGuidedSetup();
              }}
              notice={autoSwitchNotice ?? undefined}
              onDefer={deferTopic}
              onFollowUp={(text) => beginGuidedSetup(text)}
              onFinishComplete={() => {
                // One door: setup ends in the create modal, not the agent panel.
                setWelcomeOpen(false);
                setCreateModal({ mode: 'api' });
              }}
              onBuildFirst={(text) => {
                // A typed first-build answer IS the goal — open the real build
                // flow pre-filled with it instead of another interview turn.
                setWelcomeOpen(false);
                setCreateModal({ mode: 'api', initialGoal: text });
              }}
              onContinue={() => followUpRef.current?.focus()}
              followUpRef={followUpRef}
            />
          ) : (
            <>
              {effectiveStatus ? (
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
                  {/* One story: progress → the guided plan → what's done → a
                      quiet manual fallback. The full checklist (with its many
                      buttons) stays behind the disclosure so the idle screen
                      has a single primary action. */}
                  <Progress
                    done={deriveChecklist(effectiveStatus, actions).filter((i) => i.status === 'complete').length}
                    total={deriveChecklist(effectiveStatus, actions).length}
                  />
                  <GuidedSetupIntro
                    status={effectiveStatus}
                    chosenAgent={agentChoice.agent}
                    onChooseAgent={(kind) => setAgentChoice({ ...agentChoice, agent: kind })}
                    onStart={() => beginGuidedSetup()}
                  />
                  <DoneSummary status={effectiveStatus} chosenAgent={agentChoice.agent} />
                  {manualOpen && (
                    <WelcomeChecklist
                      status={effectiveStatus}
                      actions={actions}
                      chosenAgent={agentChoice.agent}
                      onChooseAgent={(kind) => setAgentChoice({ ...agentChoice, agent: kind })}
                      showProgress={false}
                    />
                  )}
                </div>
              ) : (
                <div className="py-6 text-center text-[12px] text-muted-foreground">
                  Checking your project…
                </div>
              )}
              <WelcomeFooter
                status={effectiveStatus}
                actions={actions}
                onDismiss={dismiss}
                manualOpen={manualOpen}
                onToggleManual={() => setManualOpen((o) => !o)}
              />
            </>
          )}
        </DialogContent>
      </Dialog>

      <EnvironmentsDialog
        open={envDialogOpen}
        onOpenChange={setEnvDialogOpen}
        onBack={() => {
          setEnvDialogOpen(false);
          setWelcomeOpen(true);
        }}
      />
    </>
  );
}
