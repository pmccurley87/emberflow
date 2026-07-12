import { useEffect } from 'react';
import { PanelBottomOpenIcon, PanelLeftOpenIcon, PanelRightOpenIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { AgentConsole } from './components/AgentConsole';
import { Dock } from './components/Dock';
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

/** The center panel's content: the runbook document is the sole flow surface. */
function CenterView() {
  const viewRegister = useBuilderStore((s) => s.viewRegister);
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
    </div>
  );
}
