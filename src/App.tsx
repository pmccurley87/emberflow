import { useEffect, useState } from 'react';
import { FlameIcon, PanelBottomOpenIcon, PanelLeftOpenIcon, PanelRightOpenIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { AgentConsole } from './components/AgentConsole';
import { CommandBar } from './components/CommandBar';
import { CreateModalHost } from './components/CreateModal';
import { Dock } from './components/Dock';
import { EMPTY_STATE_DISMISSED_KEY, EmptyState } from './components/EmptyState';
import { Inspector } from './components/Inspector';
import { RunConsole, useRunConsole } from './components/RunLogPanel';
import { RunbookView } from './components/RunbookView';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { Toolbar } from './components/Toolbar';
import { effectiveConsolePosition, useBuilderStore } from './store/builderStore';

/**
 * Window-level layout shortcuts (VS Code muscle memory): cmd/ctrl+B toggles the
 * sidebar, cmd/ctrl+J the bottom dock. Ignored while typing so they never eat a
 * keystroke in a field.
 */
function useLayoutShortcuts(): void {
  const toggleSidebar = useBuilderStore((s) => s.toggleSidebar);
  const toggleDock = useBuilderStore((s) => s.toggleDock);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const key = e.key.toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        toggleSidebar();
      } else if (key === 'j') {
        e.preventDefault();
        toggleDock();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar, toggleDock]);
}

/** Slim reopen tab on a closed panel's edge — the panel's own chrome, not a toolbar icon. */
function EdgeReopen({
  side,
  label,
  onClick,
  icon,
}: {
  side: 'left' | 'right' | 'bottom';
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={
        side === 'bottom'
          ? 'flex h-6 w-full shrink-0 items-center justify-center border-t border-border bg-tertiary text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground'
          : `flex h-full w-6 shrink-0 items-center justify-center bg-tertiary text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground ${side === 'left' ? 'border-r' : 'border-l'} border-border`
      }
    >
      {icon}
    </button>
  );
}

/**
 * Calm, honest offline state. The workspace (operations, environments, runs) all
 * come from the runner — with it down and no workspace ever adopted, there is
 * nothing to show and nothing to execute, so we say so plainly instead of
 * pretending an empty canvas is a project.
 */
function RunnerOfflinePanel() {
  const checkRunner = useBuilderStore((s) => s.checkRunner);
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-8">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <FlameIcon className="size-8 text-muted-foreground/50" />
        <h2 className="text-[15px] font-semibold tracking-tight">Runner offline</h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          The studio is a pure client — your operations, environments and runs all
          live on the runner. Start it, then this workspace fills in.
        </p>
        <code className="rounded-md border border-border bg-tertiary px-2.5 py-1.5 font-mono text-[12.5px] text-foreground">
          npx emberflow dev
        </code>
        <button
          type="button"
          onClick={() => void checkRunner()}
          className="mt-1 rounded-md px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
        >
          Re-check
        </button>
      </div>
    </div>
  );
}

/** The center panel's content: the runbook document is the sole flow surface. */
function CenterView() {
  const viewRegister = useBuilderStore((s) => s.viewRegister);
  const runnerOnline = useBuilderStore((s) => s.runnerOnline);
  const workspaceSource = useBuilderStore((s) => s.workspaceSource);
  const setupStatus = useBuilderStore((s) => s.setupStatus);
  const welcomeOpen = useBuilderStore((s) => s.welcomeOpen);
  const setCreateModal = useBuilderStore((s) => s.setCreateModal);
  const switchWorkflow = useBuilderStore((s) => s.switchWorkflow);
  const workflows = useBuilderStore((s) => s.workflows);
  const buildingApiLocation = useBuilderStore((s) => s.buildingApiLocation);
  // Explicit dismissal of the post-onboarding empty state ("explore the
  // example" path). Building a second op dismisses it implicitly — onlyHello
  // stops matching once setupStatus refreshes (WelcomeDialog/StatusBar refetch
  // it on agent-run finish), so no flag is written on that path.
  const [emptyDismissed, setEmptyDismissed] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem(EMPTY_STATE_DISMISSED_KEY) === '1',
  );
  // Offline AND no runner workspace ever adopted → the calm offline panel. Once
  // a workspace has been adopted (workspaceSource === 'server'), a mid-session
  // runner blip keeps showing the flow; the StatusBar carries the offline signal.
  if (runnerOnline === false && workspaceSource !== 'server') {
    return (
      <div className="relative h-full min-h-0">
        <RunnerOfflinePanel />
      </div>
    );
  }
  // Zero operations left (everything deleted): the placeholder flow must never
  // render as if it were a real op — show the empty state, undismissable, no
  // explore link (the hello example is gone too). A live build-api run keeps
  // the runbook's holding pattern instead.
  if (workspaceSource === 'server' && workflows.length === 0 && !buildingApiLocation) {
    return (
      <div className="relative h-full min-h-0">
        <EmptyState
          status={setupStatus}
          dismissed={false}
          noOps
          onCreate={() => setCreateModal({ mode: 'api' })}
          onExplore={() => {}}
        />
      </div>
    );
  }
  // Post-onboarding: the bare hello-example project gets a clear starting point
  // instead of someone else's op — hidden while the Welcome dialog still runs,
  // and while a build-api run is designing the first real API (the runbook's
  // holding pattern owns the canvas until its first operation lands).
  if (!welcomeOpen && !emptyDismissed && setupStatus?.ops.onlyHello && !buildingApiLocation) {
    return (
      <div className="relative h-full min-h-0">
        <EmptyState
          status={setupStatus}
          dismissed={emptyDismissed}
          onCreate={() => setCreateModal({ mode: 'api' })}
          onExplore={() => {
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem(EMPTY_STATE_DISMISSED_KEY, '1');
            }
            setEmptyDismissed(true);
            switchWorkflow('default/hello');
          }}
        />
      </div>
    );
  }
  return (
    <div className="relative h-full min-h-0">
      <RunbookView register={viewRegister} />
    </div>
  );
}

export default function App() {
  const sidebarOpen = useBuilderStore((s) => s.sidebarOpen);
  const dockOpen = useBuilderStore((s) => s.dockOpen);
  const inspectorOpen = useBuilderStore((s) => s.inspectorOpen);
  const selectedNodeId = useBuilderStore((s) => s.selectedNodeId);
  const consolePositionChoice = useBuilderStore((s) => s.consolePosition);
  const viewRegister = useBuilderStore((s) => s.viewRegister);
  const consolePosition = effectiveConsolePosition(consolePositionChoice, viewRegister);
  const toggleSidebar = useBuilderStore((s) => s.toggleSidebar);
  const toggleDock = useBuilderStore((s) => s.toggleDock);
  const toggleInspector = useBuilderStore((s) => s.toggleInspector);
  const dismissRunConsole = useBuilderStore((s) => s.dismissRunConsole);
  const runConsole = useRunConsole();
  const agentPanelOpen = useBuilderStore((s) => s.agentPanelOpen);
  const toggleAgentPanel = useBuilderStore((s) => s.toggleAgentPanel);
  useLayoutShortcuts();

  // The console joins the center column's vertical stack when docked bottom
  // (below the dock, or alone if the dock is closed); a vertical group is
  // only needed at all when the dock is open or the console is bottom-docked.
  const consoleBottom = runConsole.open && consolePosition === 'bottom';
  const consoleRight = runConsole.open && consolePosition === 'right';
  // The bottom run console and the dock are both log surfaces — never stack
  // two at the bottom. While the console holds the bottom, the dock yields;
  // it returns the moment the console closes (dockOpen intent is preserved).
  const showDock = dockOpen && !consoleBottom;
  const centerHasVerticalStack = showDock || consoleBottom;

  return (
    <div className="flex h-screen flex-col">
      <Toolbar />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {!sidebarOpen && (
        <EdgeReopen
          side="left"
          label="Open sidebar (⌘B)"
          onClick={toggleSidebar}
          icon={<PanelLeftOpenIcon className="size-3.5" />}
        />
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Outer group: sidebar | rest. Keeping the sidebar in its OWN group means
          opening panels on the right (inspector/run/agent) reflows only the inner
          group — the sidebar width never changes. */}
      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1" autoSaveId="emberflow-outer">
        {sidebarOpen && (
          <>
            <ResizablePanel id="sidebar" order={1} defaultSize={13} minSize={10} maxSize={25}>
              <Sidebar />
            </ResizablePanel>
            <ResizableHandle />
          </>
        )}
        <ResizablePanel id="rest" order={2} defaultSize={87}>
          {/* Inner group: canvas | inspector | run | agent. The agent panel lives
              here, so opening it pushes the canvas (and other right panels) — not
              the sidebar. */}
          <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1" autoSaveId="emberflow-main">
            <ResizablePanel id="center" order={1} defaultSize={65} minSize={35}>
              {centerHasVerticalStack ? (
                <ResizablePanelGroup direction="vertical" autoSaveId="emberflow-v">
                  <ResizablePanel id="canvas" order={1} defaultSize={showDock ? 72 : 70} minSize={40}>
                    <CenterView />
                  </ResizablePanel>
                  {showDock && (
                    <>
                      <ResizableHandle />
                      <ResizablePanel id="dock" order={2} defaultSize={28} minSize={12} maxSize={55}>
                        <Dock />
                      </ResizablePanel>
                    </>
                  )}
                  {consoleBottom && (
                    <>
                      <ResizableHandle />
                      <ResizablePanel id="run-bottom" order={3} defaultSize={30} minSize={15}>
                        <RunConsole onDismiss={dismissRunConsole} />
                      </ResizablePanel>
                    </>
                  )}
                </ResizablePanelGroup>
              ) : (
                <CenterView />
              )}
            </ResizablePanel>
            {inspectorOpen && selectedNodeId && (
              <>
                <ResizableHandle />
                <ResizablePanel id="right" order={2} defaultSize={22} minSize={15} maxSize={35}>
                  <div className="flex h-full flex-col border-l border-border bg-card">
                    <div className="flex h-8 shrink-0 items-center justify-between border-b border-border/70 px-3">
                      <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                        Inspector
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-muted-foreground hover:text-foreground"
                        onClick={toggleInspector}
                        aria-label="Close inspector"
                        title="Close inspector"
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      <Inspector />
                    </div>
                  </div>
                </ResizablePanel>
              </>
            )}
            {consoleRight && (
              <>
                <ResizableHandle />
                <ResizablePanel id="run" order={3} defaultSize={26} minSize={18} maxSize={45}>
                  <RunConsole onDismiss={dismissRunConsole} />
                </ResizablePanel>
              </>
            )}
            {agentPanelOpen && (
              <>
                <ResizableHandle />
                <ResizablePanel id="agent" order={4} defaultSize={26} minSize={18} maxSize={45}>
                  <AgentConsole onDismiss={toggleAgentPanel} />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
      {!dockOpen && (
        <EdgeReopen
          side="bottom"
          label="Open panel (⌘J)"
          onClick={toggleDock}
          icon={<PanelBottomOpenIcon className="size-3.5" />}
        />
      )}
      </div>
      {!inspectorOpen && (
        <EdgeReopen
          side="right"
          label="Open inspector"
          onClick={toggleInspector}
          icon={<PanelRightOpenIcon className="size-3.5" />}
        />
      )}
      </div>
      <StatusBar />
      {/* The one New API / New operation modal — hosted here (not in the
          Sidebar) so the canvas empty state can open it with the sidebar closed. */}
      <CreateModalHost />
      <CommandBar />
    </div>
  );
}
