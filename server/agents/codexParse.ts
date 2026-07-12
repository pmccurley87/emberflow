import type { AgentEvent } from './types';

interface CodexCommandExecutionItem {
  type: 'command_execution';
  command: string;
  status?: 'in_progress' | 'completed' | 'failed';
  exit_code?: number | null;
  aggregated_output?: string;
}

interface CodexAgentMessageItem {
  type: 'agent_message';
  text: string;
}

interface CodexErrorItem {
  type: 'error';
  // Codex has shipped both field names for the human-readable detail.
  text?: string;
  message?: string;
}

/** An MCP tool call codex made (e.g. the Emberflow MCP server's run_operation).
 *  Field names are read defensively — codex's shape may nest server/tool under
 *  `invocation` or expose them flat, and the result may arrive as result/output. */
interface CodexMcpToolCallItem {
  type: 'mcp_tool_call';
  status?: 'in_progress' | 'completed' | 'failed';
  server?: string;
  tool?: string;
  name?: string;
  invocation?: { server?: string; tool?: string };
  result?: unknown;
  output?: unknown;
  error?: string;
}

type CodexItem =
  | CodexCommandExecutionItem
  | CodexAgentMessageItem
  | CodexErrorItem
  | CodexMcpToolCallItem
  | { type: string };

/** Map a codex mcp_tool_call item → an 'mcp' AgentEvent, tolerating shape drift. */
function mcpEventFrom(item: CodexMcpToolCallItem): AgentEvent {
  const server = item.server ?? item.invocation?.server ?? 'mcp';
  const tool = item.tool ?? item.name ?? item.invocation?.tool ?? 'tool';
  const raw = item.error ?? item.result ?? item.output;
  const output = raw === undefined ? undefined : typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
  return { type: 'mcp', mcpServer: server, mcpTool: tool, mcpStatus: item.status, ...(output !== undefined ? { output } : {}) };
}

interface CodexLine {
  type: string;
  item?: CodexItem;
  usage?: Record<string, number>;
}

export function parseCodexLine(line: string): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: CodexLine;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  switch (parsed.type) {
    case 'thread.started':
    case 'turn.started':
      return { type: 'started' };

    case 'item.started': {
      const item = parsed.item;
      if (item && item.type === 'command_execution') {
        const commandItem = item as CodexCommandExecutionItem;
        return {
          type: 'command',
          command: commandItem.command,
          commandStatus: commandItem.status,
        };
      }
      if (item && item.type === 'mcp_tool_call') return mcpEventFrom(item as CodexMcpToolCallItem);
      return null;
    }

    case 'item.completed': {
      const item = parsed.item;
      if (!item) return null;
      if (item.type === 'command_execution') {
        const commandItem = item as CodexCommandExecutionItem;
        return {
          type: 'command',
          command: commandItem.command,
          exitCode: commandItem.exit_code,
          output: commandItem.aggregated_output,
          commandStatus: commandItem.status,
        };
      }
      if (item.type === 'mcp_tool_call') return mcpEventFrom(item as CodexMcpToolCallItem);
      if (item.type === 'agent_message') {
        const messageItem = item as CodexAgentMessageItem;
        return { type: 'message', text: messageItem.text };
      }
      if (item.type === 'error') {
        // A codex `error` ITEM is a non-fatal diagnostic (e.g. an MCP server
        // failing to auth) — NOT the run failing. Surface it as a message so it
        // stays visible without terminating the run. A real failure is signalled
        // by the process exiting non-zero with no `done` (see codexAdapter),
        // which is the ONLY thing that yields a terminal AgentEvent 'error'.
        const errorItem = item as CodexErrorItem;
        return { type: 'message', text: `⚠ ${errorItem.text ?? errorItem.message ?? 'error'}` };
      }
      return null;
    }

    case 'turn.completed':
      return { type: 'done', usage: parsed.usage };

    default:
      return null;
  }
}
