#!/usr/bin/env node
// Test fixture for runManager tests: behaves like fake-codex.mjs (prints a
// started/command/message/done sequence) but ALSO mutates a real tracked
// file in the project dir it was invoked with `-C <dir>`, so diff/revert
// against a real git snapshot can be exercised end-to-end. `git diff` never
// shows untracked files, so this must touch a file that's already committed
// (unlike a brand-new file) for the diff assertion to see real content.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const cIndex = process.argv.indexOf('-C');
const projectDir = cIndex !== -1 ? process.argv[cIndex + 1] : process.cwd();

writeFileSync(join(projectDir, 'flows', 'hello.json'), 'agent was here\n');

const lines = [
  { type: 'thread.started' },
  { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'in_progress' } },
  { type: 'item.completed', item: { type: 'agent_message', text: 'Done listing files' } },
  { type: 'turn.completed', usage: { output_tokens: 5 } },
];

for (const line of lines) {
  process.stdout.write(JSON.stringify(line) + '\n');
}

process.exit(0);
