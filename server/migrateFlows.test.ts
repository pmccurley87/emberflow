import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateFlowsToApis } from './migrateFlows';

let ef: string;
let flowsDir: string;
let apisDir: string;
beforeEach(() => {
  ef = join(tmpdir(), `mig-${Math.random().toString(36).slice(2)}`);
  flowsDir = join(ef, 'flows');
  apisDir = join(ef, 'apis');
  mkdirSync(flowsDir, { recursive: true });
  writeFileSync(join(flowsDir, 'triage.json'), JSON.stringify({ id: 'triage', name: 'Triage', nodes: [], edges: [] }));
  writeFileSync(join(flowsDir, 'triage.scenarios.json'), JSON.stringify([{ name: 'x', input: {} }]));
});
afterEach(() => rmSync(ef, { recursive: true, force: true }));

describe('migrateFlowsToApis', () => {
  it('moves flat flows into apis/default/, keeping ids and sidecars', () => {
    const { moved } = migrateFlowsToApis(flowsDir, apisDir);
    expect(moved).toContain('triage');
    expect(existsSync(join(apisDir, 'default', 'triage.json'))).toBe(true);
    expect(existsSync(join(apisDir, 'default', 'triage.scenarios.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(apisDir, 'default', 'triage.json'), 'utf8')).id).toBe('triage');
    expect(existsSync(flowsDir)).toBe(false);
  });

  it('is a no-op when apis/ already exists', () => {
    mkdirSync(apisDir, { recursive: true });
    const { moved } = migrateFlowsToApis(flowsDir, apisDir);
    expect(moved).toEqual([]);
    expect(existsSync(flowsDir)).toBe(true); // untouched
  });

  it('is a no-op when there is no flows/ dir', () => {
    rmSync(flowsDir, { recursive: true });
    expect(migrateFlowsToApis(flowsDir, apisDir).moved).toEqual([]);
  });

  it('migrates a custom-named flows directory (e.g. my-flows) the same way', () => {
    const customFlowsDir = join(ef, 'my-flows');
    mkdirSync(customFlowsDir, { recursive: true });
    writeFileSync(
      join(customFlowsDir, 'onboarding.json'),
      JSON.stringify({ id: 'onboarding', name: 'Onboarding', nodes: [], edges: [] }),
    );
    const customApisDir = join(ef, 'apis');
    const { moved } = migrateFlowsToApis(customFlowsDir, customApisDir);
    expect(moved).toContain('onboarding');
    expect(existsSync(join(customApisDir, 'default', 'onboarding.json'))).toBe(true);
    expect(existsSync(customFlowsDir)).toBe(false);
  });
});
