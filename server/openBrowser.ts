import { spawn as nodeSpawn } from 'node:child_process';

interface OpenDeps {
  platform?: NodeJS.Platform;
  spawn?: typeof nodeSpawn;
}

/** Open the default browser at `url`. Best-effort — never throws into the caller. */
export function openBrowser(url: string, deps: OpenDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? nodeSpawn;
  const [cmd, args] =
    platform === 'darwin' ? ['open', [url]]
    : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref?.();
  } catch {
    // headless / no browser — the URL is printed by the caller anyway
  }
}
