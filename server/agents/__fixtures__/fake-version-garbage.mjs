#!/usr/bin/env node
// Test fixture for detect.test.ts: exits clean but prints no parseable semver token.
process.stdout.write('some unversioned build\n');
process.exit(0);
