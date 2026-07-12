#!/usr/bin/env node
// Test fixture: fakes `claude -p ... --output-format stream-json` output. Ignores all args.
// Prints fixture stream-json JSONL lines to stdout, then exits.
// Modes (env vars):
//   default                     → system/init, assistant text, assistant Bash tool_use, result/success; exit 0
//   FAKE_CLAUDE_FAIL=1           → system/init, assistant text + stderr noise; exit 1 (no result)
//   FAKE_CLAUDE_NODONE=1         → system/init, assistant text; exit 0 (no result event)
//   FAKE_CLAUDE_MODEL_REJECT=1   → system/init, assistant text + stderr "unknown model"; exit 1 (no result)
//   FAKE_CLAUDE_HANG=1           → system/init, assistant text; ignores SIGTERM and hangs
//                                 until killed (SIGKILL), to exercise cancel() escalation

const lines = [
  { type: 'system', subtype: 'init', session_id: 'fake-session' },
  {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Working on it' }] },
  },
  {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
  },
  {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file1\nfile2' }] },
  },
];

for (const line of lines) {
  process.stdout.write(JSON.stringify(line) + '\n');
}

if (process.env.FAKE_CLAUDE_HANG === '1') {
  process.on('SIGTERM', () => {
    // Simulate a stuck child that ignores SIGTERM — only SIGKILL (uncatchable)
    // will end it.
  });
  setInterval(() => {}, 100000);
} else {
  if (process.env.FAKE_CLAUDE_FAIL === '1') {
    process.stderr.write('some non-fatal noise\n');
    process.exit(1);
  }

  if (process.env.FAKE_CLAUDE_MODEL_REJECT === '1') {
    process.stderr.write('Error: unknown model "claude-9000"\n');
    process.exit(1);
  }

  if (process.env.FAKE_CLAUDE_NODONE === '1') {
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', usage: { output_tokens: 5 } }) + '\n');
  process.exit(0);
}
