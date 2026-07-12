import { describe, expect, it } from 'vitest';
import { openBrowser } from './openBrowser';

describe('openBrowser', () => {
  it('invokes the platform opener with the url', () => {
    const calls: Array<[string, string[]]> = [];
    const fakeSpawn = ((cmd: string, args: string[]) => { calls.push([cmd, args]); return { unref() {} }; }) as never;
    openBrowser('http://localhost:8092', { platform: 'darwin', spawn: fakeSpawn });
    expect(calls[0][0]).toBe('open');
    expect(calls[0][1]).toContain('http://localhost:8092');
  });

  it('uses xdg-open on linux and start on win32', () => {
    const seen: string[] = [];
    const fakeSpawn = ((cmd: string) => { seen.push(cmd); return { unref() {} }; }) as never;
    openBrowser('http://x', { platform: 'linux', spawn: fakeSpawn });
    openBrowser('http://x', { platform: 'win32', spawn: fakeSpawn });
    expect(seen).toEqual(['xdg-open', 'cmd']);
  });
});
