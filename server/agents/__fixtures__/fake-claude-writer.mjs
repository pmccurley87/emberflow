#!/usr/bin/env node
// Test fixture for runManager tests: behaves like fake-claude.mjs (prints a
// started/message/command/done sequence) but ALSO mutates a real tracked
// file in the project dir. spawnClaude runs the child with cwd=projectDir
// (unlike codex, which passes -C explicitly), so this fixture just writes
// relative to process.cwd().
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

writeFileSync(join(process.cwd(), 'flows', 'hello.json'), 'agent was here\n');

const lines = [
  { type: 'system', subtype: 'init', session_id: 'fake-session' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
  { type: 'result', subtype: 'success', usage: { output_tokens: 5 } },
];

for (const line of lines) {
  process.stdout.write(JSON.stringify(line) + '\n');
}

process.exit(0);
