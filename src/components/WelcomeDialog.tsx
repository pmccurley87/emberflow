import { useEffect, useState } from 'react';
import {
  CheckCircle2Icon,
  CheckIcon,
  CircleIcon,
  CopyIcon,
  MinusCircleIcon,
  SparklesIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { EnvironmentsDialog } from './EnvironmentsDialog';
import { useBuilderStore } from '../store/builderStore';
import { fetchSetupStatus, type SetupStatus } from '../store/setupClient';

const WELCOME_DISMISSED_KEY = 'emberflow.welcome.dismissed';
/** Re-run this exact command to (re)install the agent skills only. */
const SKILLS_INSTALL_COMMAND = 'npx emberflow init --local --no-launch';

type RowStatus = 'complete' | 'incomplete' | 'unavailable';

function StatusGlyph({ status }: { status: RowStatus }) {
  if (status === 'complete') {
    return <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" aria-label="done" />;
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
      className="mt-0.5 size-4 shrink-0 text-muted-foreground/50"
      aria-label="to do"
    />
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
      {children}
    </div>
  );
}

function ChecklistRow({
  status,
  title,
  detail,
  action,
  children,
}: {
  status: RowStatus;
  title: string;
  detail: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-border/70 px-2.5 py-2">
      <StatusGlyph status={status} />
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
export function WelcomeChecklist({
  status,
  actions = NOOP_ACTIONS,
}: {
  status: SetupStatus;
  actions?: WelcomeChecklistActions;
}) {
  const { agents, environments, skills, ops, infrastructure } = status;
  const hasAgent = agents.length > 0;
  const skillsInstalled = skills.claude || skills.codex;

  const agentDetail = hasAgent
    ? agents.map((a) => `${a.kind}${a.version ? ` ${a.version}` : ''}`).join(', ')
    : 'None detected on PATH — install codex or claude to let the agent build for you.';

  const envDetail = environments.configured
    ? `${environments.count} environment${environments.count === 1 ? '' : 's'}` +
      (environments.protectedCount > 0 ? `, ${environments.protectedCount} protected` : '')
    : "You're in Mock — nothing real is touched. Set up environments to point runs at real systems.";

  const secretsStatus: RowStatus = !environments.configured
    ? 'unavailable'
    : environments.anyAuthConfigured
      ? 'complete'
      : 'incomplete';
  const secretsDetail = !environments.configured
    ? 'Configure environments first — secrets and auth live per environment.'
    : environments.anyAuthConfigured
      ? 'Auth configured on at least one environment.'
      : 'Add the secrets and login your operations need.';

  return (
    <div className="space-y-2.5">
      <SectionTitle>Setup checklist</SectionTitle>
      <div className="flex flex-col gap-1.5">
        <ChecklistRow
          status={hasAgent ? 'complete' : 'incomplete'}
          title="Coding agent detected"
          detail={agentDetail}
          action={
            <Button variant="outline" size="sm" onClick={actions.onOpenSettings}>
              Settings
            </Button>
          }
        />

        <ChecklistRow
          status={environments.configured ? 'complete' : 'incomplete'}
          title="Environments configured"
          detail={envDetail}
          action={
            <div className="flex flex-col items-end gap-1">
              <Button size="sm" onClick={actions.onSetupEnvironments}>
                <SparklesIcon className="size-3.5" />
                Set up with AI
              </Button>
              <button
                type="button"
                onClick={actions.onOpenEnvironments}
                className="text-[10.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Manage manually
              </button>
            </div>
          }
        />

        <ChecklistRow
          status={secretsStatus}
          title="Secrets & auth"
          detail={secretsDetail}
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={!environments.configured}
              onClick={actions.onOpenEnvironments}
            >
              Open
            </Button>
          }
        />

        <ChecklistRow
          status={skillsInstalled ? 'complete' : 'incomplete'}
          title="Agent skills installed"
          detail={
            skillsInstalled
              ? 'emberflow-basics is installed for your agent.'
              : 'Re-run init (skills only) so the agent knows Emberflow conventions:'
          }
        >
          {!skillsInstalled && <CopyCommand command={SKILLS_INSTALL_COMMAND} />}
        </ChecklistRow>

        <ChecklistRow
          status={infrastructure.present ? 'complete' : 'incomplete'}
          title="Infrastructure scouted"
          detail={
            infrastructure.present
              ? `${infrastructure.itemCount ?? 0} item${infrastructure.itemCount === 1 ? '' : 's'} discovered.`
              : 'Have the agent scan this project for databases, APIs and providers it already uses.'
          }
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={!hasAgent}
              title={hasAgent ? undefined : 'Detect a coding agent first'}
              onClick={actions.onScoutInfrastructure}
            >
              <SparklesIcon className="size-3.5" />
              Scout
            </Button>
          }
        />

        <ChecklistRow
          status={ops.count > 1 ? 'complete' : 'incomplete'}
          title="First operation"
          detail={
            ops.count > 1
              ? "You've built beyond the hello example."
              : 'Only the hello example so far — open it to see how an operation is built.'
          }
          action={
            <Button variant="outline" size="sm" onClick={actions.onOpenHelloOp}>
              Open hello op
            </Button>
          }
        />
      </div>
    </div>
  );
}

/**
 * First-run Welcome/Setup dialog. Mounted once (in the Toolbar). Fetches
 * `/setup-status` on mount to decide whether to auto-open on a fresh project,
 * and again whenever it's opened so the rows reflect the latest state. Always
 * reachable from the Toolbar's Setup button (via the store's `welcomeOpen`).
 */
export function WelcomeDialog() {
  const welcomeOpen = useBuilderStore((s) => s.welcomeOpen);
  const setWelcomeOpen = useBuilderStore((s) => s.setWelcomeOpen);
  const setSettingsOpen = useBuilderStore((s) => s.setSettingsOpen);
  const beginEnvironmentSetup = useBuilderStore((s) => s.beginEnvironmentSetup);
  const beginInfrastructureScout = useBuilderStore((s) => s.beginInfrastructureScout);
  const switchWorkflow = useBuilderStore((s) => s.switchWorkflow);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [envDialogOpen, setEnvDialogOpen] = useState(false);

  // Mount: fetch once and auto-open on a fresh, undismissed project.
  useEffect(() => {
    let cancelled = false;
    void fetchSetupStatus().then((s) => {
      if (cancelled || !s) return;
      setStatus(s);
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

  // Refresh the rows every time the dialog opens (e.g. from the Toolbar button).
  useEffect(() => {
    if (!welcomeOpen) return;
    let cancelled = false;
    void fetchSetupStatus().then((s) => {
      if (!cancelled && s) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, [welcomeOpen]);

  /** A user-driven close (X / overlay / esc / Dismiss) records the dismissal so
   *  the dialog never auto-opens again; navigational actions close without it. */
  const dismiss = () => {
    setWelcomeOpen(false);
    if (typeof localStorage !== 'undefined') localStorage.setItem(WELCOME_DISMISSED_KEY, '1');
  };

  const actions: WelcomeChecklistActions = {
    onOpenSettings: () => {
      setWelcomeOpen(false);
      setSettingsOpen(true);
    },
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
            A few steps to get this project ready to build and run. Everything here is optional —
            you can revisit it any time from the toolbar.
          </DialogDescription>
          {status ? (
            <WelcomeChecklist status={status} actions={actions} />
          ) : (
            <div className="py-6 text-center text-[12px] text-muted-foreground">
              Checking your project…
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={dismiss}>
              Dismiss
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <EnvironmentsDialog open={envDialogOpen} onOpenChange={setEnvDialogOpen} />
    </>
  );
}
