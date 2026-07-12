#!/usr/bin/env node
// Test fixture: fakes `codex exec --json` output. Ignores all args.
// Prints fixture JSONL lines to stdout, then exits.
// Modes (env vars):
//   default                    → started, command, message, turn.completed; exit 0
//   FAKE_CODEX_FAIL=1          → started, command, message + stderr noise; exit 1 (no done)
//   FAKE_CODEX_MANY=1          → started, command, message, 27 filler, turn.completed; exit 0 (race test)
//   FAKE_CODEX_NODONE=1        → started, command, message; exit 0 (no turn.completed)
//   FAKE_CODEX_MODEL_REJECT=1  → started, command, message + stderr "unsupported model"; exit 1 (no done)
//   FAKE_CODEX_HANG=1          → started, command, message; ignores SIGTERM and hangs
//                                until killed (SIGKILL), to exercise cancel() escalation

const lines = [
  { type: 'thread.started' },
  { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'in_progress' } },
  { type: 'item.completed', item: { type: 'agent_message', text: 'Done listing files' } },
];

if (process.env.FAKE_CODEX_MANY === '1') {
  for (let i = 0; i < 27; i++) {
    lines.push({ type: 'item.completed', item: { type: 'agent_message', text: `filler ${i}` } });
  }
}

for (const line of lines) {
  process.stdout.write(JSON.stringify(line) + '\n');
}

if (process.env.FAKE_CODEX_HANG === '1') {
  process.on('SIGTERM', () => {
    // Simulate a stuck child that ignores SIGTERM — only SIGKILL (uncatchable)
    // will end it.
  });
  setInterval(() => {}, 100000);
} else {
  if (process.env.FAKE_CODEX_FAIL === '1') {
    process.stderr.write('some non-fatal mcp auth error\n');
    process.exit(1);
  }

  if (process.env.FAKE_CODEX_MODEL_REJECT === '1') {
    process.stderr.write('Error: unsupported model \'gpt-5.6-sol\'\n');
    process.exit(1);
  }

  if (process.env.FAKE_CODEX_NODONE === '1') {
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 5 } }) + '\n');
  process.exit(0);
}
