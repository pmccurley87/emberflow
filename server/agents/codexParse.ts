import type { AgentEvent } from './types';
import { modelRejectionHint } from './modelRejectionHint';

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
  message?: string;
  error?: { message?: string };
}

/**
 * Codex wraps API failures as JSON-in-a-string: `turn.failed`'s error.message
 * (and top-level `error`'s message) is often itself a serialized
 * `{"type":"error","status":400,"error":{"message":"…"}}` payload. Dig out the
 * innermost human-readable message, falling back to the raw string.
 */
function extractCodexErrorMessage(raw: string | undefined): string {
  if (!raw) return 'codex turn failed';
  try {
    const inner = JSON.parse(raw) as { error?: { message?: string }; message?: string };
    return inner.error?.message ?? inner.message ?? raw;
  } catch {
    return raw;
  }
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

    // The turn itself failed (e.g. the API rejected the request) — this IS the
    // run failing, unlike an `error` ITEM above. Codex exits 1 after emitting
    // it; without handling it here the adapter can only synthesize a generic
    // "codex exited with code 1" and the real cause stays buried.
    case 'turn.failed': {
      const text = extractCodexErrorMessage(parsed.error?.message);
      const hint = modelRejectionHint('codex', text);
      return { type: 'error', text: hint ? `${text} (${hint})` : text };
    }

    // Top-level `error` lines precede turn.failed with the same payload —
    // surface as a visible diagnostic, let turn.failed be the terminal event.
    case 'error':
      return { type: 'message', text: `⚠ ${extractCodexErrorMessage(parsed.message)}` };

    default:
      return null;
  }
}
