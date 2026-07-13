import { useEffect, useState } from 'react';
import {
  CheckCircle2Icon,
  CheckIcon,
  CircleIcon,
  CopyIcon,
  MinusCircleIcon,
  SparklesIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { EnvironmentsDialog } from './EnvironmentsDialog';
import { useBuilderStore } from '../store/builderStore';
import type { SetupStatus } from '../store/setupClient';
import type { AgentKind } from '../store/agentClient';

const WELCOME_DISMISSED_KEY = 'emberflow.welcome.dismissed';
/** Re-run this exact command to (re)install the agent skills only. */
const SKILLS_INSTALL_COMMAND = 'npx emberflow init --local --no-launch';

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

function CopyCommand({ command }: { command: string }) {
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
  extra?: 'skills-command' | 'manage-manually';
}

/** Derive the checklist rows once — the dialog reuses this for its footer CTA. */
export function deriveChecklist(status: SetupStatus, actions: WelcomeChecklistActions): ChecklistItem[] {
  const { agents, environments, skills, ops, infrastructure } = status;
  const hasAgent = agents.length > 0;
  const skillsInstalled = skills.claude || skills.codex;
  const agentSummary = agents.map((a) => `${a.kind}${a.version ? ` ${a.version}` : ''}`).join(', ');

  return [
    {
      key: 'agent',
      status: hasAgent ? 'complete' : 'incomplete',
      title: 'Coding agent',
      detail: 'None detected on PATH — install codex or claude to let the agent build for you.',
      completedDetail: agentSummary,
      actionLabel: 'Settings',
      onAction: actions.onOpenSettings,
    },
    {
      key: 'environments',
      status: environments.configured ? 'complete' : 'incomplete',
      title: 'Environments',
      detail:
        "You're in Mock — nothing real is touched. Point runs at real systems when you're ready.",
      completedDetail:
        `${environments.count} environment${environments.count === 1 ? '' : 's'}` +
        (environments.protectedCount > 0 ? `, ${environments.protectedCount} protected` : ''),
      actionLabel: environments.configured ? 'Manage' : 'Set up with AI',
      actionSparkle: !environments.configured,
      onAction: environments.configured ? actions.onOpenEnvironments : actions.onSetupEnvironments,
      extra: environments.configured ? undefined : 'manage-manually',
    },
    {
      key: 'secrets',
      status: !environments.configured
        ? 'unavailable'
        : environments.anyAuthConfigured
          ? 'complete'
          : 'incomplete',
      title: 'Secrets & auth',
      detail: !environments.configured
        ? 'Configure environments first — secrets and auth live per environment.'
        : 'Add the secrets and login your operations need.',
      completedDetail: 'Auth configured',
      actionLabel: 'Add secrets',
      actionDisabled: !environments.configured,
      onAction: actions.onOpenEnvironments,
    },
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
      key: 'infrastructure',
      status: infrastructure.present ? 'complete' : 'incomplete',
      title: 'Infrastructure scouted',
      detail: 'The agent scans this project for databases, APIs and providers it already uses.',
      completedDetail: `${infrastructure.itemCount ?? 0} item${infrastructure.itemCount === 1 ? '' : 's'} found`,
      actionLabel: 'Scout',
      actionSparkle: true,
      actionDisabled: !hasAgent,
      actionDisabledReason: 'Detect a coding agent first',
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

export function WelcomeChecklist({
  status,
  actions = NOOP_ACTIONS,
  chosenAgent,
  onChooseAgent,
}: {
  status: SetupStatus;
  actions?: WelcomeChecklistActions;
  /** The user's preferred agent (from Settings); defaults to the first detected. */
  chosenAgent?: AgentKind;
  onChooseAgent?: (kind: AgentKind) => void;
}) {
  const items = deriveChecklist(status, actions);
  const done = items.filter((i) => i.status === 'complete').length;
  const nextIdx = nextStepIndex(items);

  // With more than one agent CLI on PATH the agent row becomes a choice, not a
  // fact: an inline picker replaces the compressed summary and stays live.
  const multipleAgents = status.agents.length > 1 && onChooseAgent !== undefined;
  const activeAgent = chosenAgent ?? status.agents[0]?.kind;
  const agentPicker = multipleAgents ? (
    <div className="flex min-w-0 flex-1 gap-1" role="group" aria-label="Choose coding agent">
      {status.agents.map(({ kind, version }) => (
        <button
          key={kind}
          type="button"
          onClick={() => onChooseAgent(kind)}
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
  ) : undefined;

  return (
    <div className="space-y-3">
      <Progress done={done} total={items.length} />
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
 * steps done → pull toward the real aha: asking the agent to build.
 * "Don't show again" is the true dismissal (records the flag).
 */
function WelcomeFooter({
  status,
  actions,
  onDismiss,
}: {
  status: SetupStatus | null;
  actions: WelcomeChecklistActions;
  onDismiss: () => void;
}) {
  const openAgentPanel = useBuilderStore((s) => s.openAgentPanel);
  const setWelcomeOpen = useBuilderStore((s) => s.setWelcomeOpen);
  const items = status ? deriveChecklist(status, actions) : [];
  const nextIdx = status ? nextStepIndex(items) : -1;
  const next = nextIdx === -1 ? undefined : items[nextIdx];

  return (
    <div className="flex items-center justify-between">
      <button
        type="button"
        onClick={onDismiss}
        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Don't show this again
      </button>
      {/* The emphasized row owns the next-step primary; the footer only takes
          over once everything is done — pulling toward the real aha. */}
      {status && !next && (
        <Button
          size="sm"
          onClick={() => {
            setWelcomeOpen(false);
            openAgentPanel();
          }}
        >
          <SparklesIcon className="size-3.5" />
          You're set — ask the agent to build
        </Button>
      )}
    </div>
  );
}

/**
 * First-run Welcome/Setup dialog. Mounted once (in the Toolbar). Fetches
 * `/setup-status` on mount to decide whether to auto-open on a fresh project,
 * and again whenever it's opened so the rows reflect the latest state. Always
 * reachable from the StatusBar's setup chip (via the store's `welcomeOpen`).
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
  const [envDialogOpen, setEnvDialogOpen] = useState(false);

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

  return (
    <>
      <Dialog open={welcomeOpen} onOpenChange={(o) => (o ? setWelcomeOpen(true) : dismiss())}>
        <DialogContent className="max-w-lg">
          <DialogTitle>Welcome to Emberflow</DialogTitle>
          <DialogDescription>
            Get this project ready to build and run — revisit any time from the setup chip in the
            status bar.
          </DialogDescription>
          {status ? (
            <WelcomeChecklist
              status={status}
              actions={actions}
              chosenAgent={agentChoice.agent}
              onChooseAgent={(kind) => setAgentChoice({ ...agentChoice, agent: kind })}
            />
          ) : (
            <div className="py-6 text-center text-[12px] text-muted-foreground">
              Checking your project…
            </div>
          )}
          <WelcomeFooter status={status} actions={actions} onDismiss={dismiss} />
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
