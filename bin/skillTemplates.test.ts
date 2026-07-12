import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const skill = (name: string): string =>
  readFileSync(join('templates', 'skills', name, 'SKILL.md'), 'utf8');

describe('Emberflow skill templates', () => {
  it('prevents scenario-only verification from hiding missing Input defaults', () => {
    const basics = skill('emberflow-basics');
    const newWorkflow = skill('emberflow-new-workflow');
    const modelProcess = skill('emberflow-model-process');
    const review = skill('emberflow-review-workflow');

    expect(basics).toContain('Plain Run');
    expect(newWorkflow).toContain('Run both: plain Run and scenarios');
    expect(modelProcess).toContain('Run both: plain Run and every scenario');
    expect(review).toContain('Plain Run / default input check');
  });

  it('documents the committed infrastructure manifest and points the intake skills at it first', () => {
    const basics = skill('emberflow-basics');
    const newWorkflow = skill('emberflow-new-workflow');
    const modelProcess = skill('emberflow-model-process');

    // Basics: file-layout entry — committed, structure-only, written by the scout.
    expect(basics).toContain('emberflow/infrastructure.json');
    expect(basics).toMatch(/committed.*structure-only|structure-only.*committed/i);
    expect(basics).toMatch(/scout/i);

    // Intake sections: check the manifest FIRST before interviewing about infra.
    for (const skillText of [newWorkflow, modelProcess]) {
      expect(skillText).toContain('emberflow/infrastructure.json');
      expect(skillText).toMatch(/FIRST/);
    }
  });
});
