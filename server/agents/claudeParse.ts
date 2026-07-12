import type { AgentEvent } from './types';

interface ClaudeToolResultTextBlock {
  type: string;
  text?: string;
}

interface ClaudeContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string; // tool_use id (assistant tool_use blocks)
  tool_use_id?: string; // correlates a tool_result back to its tool_use
  content?: string | ClaudeToolResultTextBlock[]; // tool_result payload
  is_error?: boolean; // tool_result failure flag
}

interface ClaudeLine {
  type: string;
  subtype?: string;
  is_error?: boolean;
  message?: {
    content?: ClaudeContentBlock[];
  };
  result?: string;
  usage?: Record<string, number>;
}

/** Best-effort extraction of a shell command from a Bash tool_use input. */
function bashCommandFrom(block: ClaudeContentBlock): string | undefined {
  const input = block.input;
  if (!input) return undefined;
  const command = input.command;
  return typeof command === 'string' ? command : undefined;
}

/** Fallback label for a tool whose input we don't format specially (or that's
 *  missing its expected field): `<name> <compact-json>` capped at 80 chars. */
function compactLabel(name: string, input: Record<string, unknown>): string {
  const json = JSON.stringify(input ?? {});
  return `${name} ${json.length > 80 ? json.slice(0, 80) : json}`;
}

/**
 * Human label for a non-mcp tool_use block, used as a `command` event's
 * `command` string so Read/Edit/Grep/… fold into the UI's "Ran N commands"
 * group instead of leaking as reasoning prose. Bash keeps its raw shell command;
 * the common Claude tools get a purpose-built one-liner; anything else gets the
 * compact `<name> <json>` fallback.
 */
function commandLabelFor(block: ClaudeContentBlock): string {
  const name = block.name ?? 'tool';
  const input = (block.input ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  switch (name) {
    case 'Bash':
      return bashCommandFrom(block) ?? compactLabel(name, input);
    case 'Read': {
      const fp = str(input.file_path);
      if (!fp) return compactLabel(name, input);
      const bits: string[] = [];
      if (typeof input.offset === 'number') bits.push(`offset ${input.offset}`);
      if (typeof input.limit === 'number') bits.push(`limit ${input.limit}`);
      return `Read ${fp}${bits.length ? ` (${bits.join(', ')})` : ''}`;
    }
    case 'Edit':
    case 'Write': {
      const fp = str(input.file_path);
      return fp ? `${name} ${fp}` : compactLabel(name, input);
    }
    case 'Grep': {
      const pattern = str(input.pattern);
      if (!pattern) return compactLabel(name, input);
      const path = str(input.path);
      return `Grep ${pattern}${path ? ` ${path}` : ''}`;
    }
    case 'Glob': {
      const pattern = str(input.pattern);
      return pattern ? `Glob ${pattern}` : compactLabel(name, input);
    }
    case 'TodoWrite':
      return 'update todos';
    default:
      return compactLabel(name, input);
  }
}

/** Flattens a tool_result's `content` (string, or array of text blocks) to plain text. */
function toolResultTextFrom(block: ClaudeContentBlock): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
  }
  return '';
}

export function parseClaudeLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let parsed: ClaudeLine;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  switch (parsed.type) {
    case 'system': {
      if (parsed.subtype === 'init') return [{ type: 'started' }];
      // hook_started / hook_response and any other system noise — ignore.
      return [];
    }

    case 'assistant': {
      const blocks = parsed.message?.content ?? [];
      // Claude routinely emits multiple content blocks per message (e.g.
      // explain-then-call `[text, tool_use]`, or parallel tool calls) — emit
      // one AgentEvent per meaningful block, in order, so the console shows the
      // full picture. `thinking` and other block types are skipped.
      const events: AgentEvent[] = [];
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          events.push({ type: 'message', text: block.text });
        } else if (block.type === 'tool_use') {
          // MCP tools surface as `mcp__<server>__<tool>` — show them as MCP calls.
          if (block.name?.startsWith('mcp__')) {
            const [, server, ...toolParts] = block.name.split('__');
            events.push({
              type: 'mcp',
              mcpServer: server || 'mcp',
              mcpTool: toolParts.join('__') || 'tool',
              mcpStatus: 'in_progress',
              ...(block.id ? { toolUseId: block.id } : {}),
            });
            continue;
          }
          // Every other tool (Bash, Read, Edit, Grep, Glob, TodoWrite, …) is a
          // `command` event with a human label, correlated by tool_use_id like
          // Bash always was — so it folds into the UI's "Ran N commands" group
          // instead of leaking as reasoning prose.
          events.push({
            type: 'command',
            command: commandLabelFor(block),
            commandStatus: 'in_progress',
            ...(block.id ? { toolUseId: block.id } : {}),
          });
        }
      }
      return events;
    }

    case 'user': {
      // Tool results. Emit a partial completion carrying the tool_use_id +
      // output text + status; the adapter looks up the original command text
      // by id (it isn't repeated in the tool_result line) and skips gracefully
      // if the id doesn't correspond to a command it's tracking (e.g. a
      // non-Bash tool result).
      const blocks = parsed.message?.content ?? [];
      const events: AgentEvent[] = [];
      for (const block of blocks) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          events.push({
            type: 'command',
            toolUseId: block.tool_use_id,
            commandStatus: block.is_error ? 'failed' : 'completed',
            output: toolResultTextFrom(block),
          });
        }
      }
      return events;
    }

    case 'result': {
      if (parsed.subtype === 'error' || parsed.is_error) {
        return [{ type: 'error', text: parsed.result ?? 'error' }];
      }
      return [{ type: 'done', usage: parsed.usage }];
    }

    case 'rate_limit_event':
      return [];

    default:
      return [];
  }
}
