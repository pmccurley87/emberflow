#!/usr/bin/env node
// Test fixture for detect.test.ts: exits nonzero (binary present but --version unsupported/broken).
process.stderr.write('unknown flag --version\n');
process.exit(1);
