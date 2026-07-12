#!/usr/bin/env node
// Test fixture for detect.test.ts: never exits — exercises the probe() timeout.
setInterval(() => {}, 100000);
