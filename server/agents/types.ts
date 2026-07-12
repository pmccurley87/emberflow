export type AgentKind = 'codex' | 'claude';

export interface AgentEvent {
  type: 'started' | 'message' | 'command' | 'mcp' | 'approval-request' | 'done' | 'error';
  text?: string; // message/error text
  command?: string; // for 'command'
  commandStatus?: 'in_progress' | 'completed' | 'failed';
  exitCode?: number | null; // for 'command'
  output?: string; // command aggregated output OR an mcp call's result
  toolUseId?: string; // for 'command'/'mcp' (Claude) — correlates a tool_use with its later tool_result
  approvalId?: string; // for 'approval-request' (Claude)
  usage?: Record<string, number>; // for 'done'
  // ── 'mcp': the agent called an Emberflow MCP tool (run/list/delete/etc.) ──
  mcpServer?: string; // e.g. 'emberflow'
  mcpTool?: string; // e.g. 'run_operation'
  mcpStatus?: 'in_progress' | 'completed' | 'failed';
}
