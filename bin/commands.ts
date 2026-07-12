import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { decideRuntime, resolveProjectDir } from './runtime.mjs';

export interface ParsedArgs {
  command: string;
  port?: number;
  project?: string;
  scenario?: string;
  noSkills?: boolean;
  scope?: 'global' | 'repo';
  noLaunch?: boolean;
  mock?: boolean;
  js?: boolean;
  ts?: boolean;
  rest: string[];
}

/** How the bin decided to run — passed down from bin/emberflow.mjs (see
 *  bin/runtime.mjs). `runnerMode` selects `node dist/server/*.js` vs a tsx spawn;
 *  `packageRoot` is the real package root (bin/emberflow.mjs is never in dist, so
 *  it always resolves this correctly — unlike this module's own location, which
 *  is dist/bin/commands.js when compiled). */
export interface RuntimeContext {
  runnerMode: 'node' | 'tsx';
  packageRoot: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...tail] = argv;
  const out: ParsedArgs = { command, rest: [] };
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a === '--port') out.port = Number(tail[++i]);
    else if (a === '--project') out.project = tail[++i];
    else if (a === '--scenario') out.scenario = tail[++i];
    else if (a === '--no-skills') out.noSkills = true;
    else if (a === '--global') out.scope = 'global';
    else if (a === '--local') out.scope = 'repo';
    else if (a === '--no-launch') out.noLaunch = true;
    else if (a === '--mock') out.mock = true;
    else if (a === '--js') out.js = true;
    else if (a === '--ts') out.ts = true;
    else out.rest.push(a);
  }
  return out;
}

/** Ask the user whether to install skills globally or per-repo. Guarded on TTY so
 *  it never hangs a non-interactive run (tests, CI, piped input). */
function promptScope(): Promise<'global' | 'repo'> {
  if (!process.stdin.isTTY) return Promise.resolve('repo');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(
      'Install Emberflow skills for [g]lobal (all projects) or [r]epo (this project)? [r] ',
      (answer) => {
        rl.close();
        res(answer.trim().toLowerCase().startsWith('g') ? 'global' : 'repo');
      }
    );
  });
}

/** Ask the user which language to author their APIs/nodes in. Same TTY guard as
 *  promptScope — never hangs a non-interactive run (tests, CI, piped input),
 *  defaulting to javascript. */
function promptLanguage(): Promise<'javascript' | 'typescript'> {
  if (!process.stdin.isTTY) return Promise.resolve('javascript');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(
      'Author your APIs in [j]avascript or [t]ypescript? [j] ',
      (answer) => {
        rl.close();
        res(answer.trim().toLowerCase().startsWith('t') ? 'typescript' : 'javascript');
      }
    );
  });
}

/** Fallback package root used when runCommand is called without a RuntimeContext
 *  (e.g. a direct unit test). In normal use bin/emberflow.mjs passes the real
 *  root — important because this module compiles to dist/bin/commands.js, whose
 *  own `..` is dist/, not the package root. */
const selfPkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const defaultCtx: RuntimeContext = { runnerMode: 'tsx', packageRoot: selfPkgRoot };

/** Spawn `tsx <entry>` inheriting stdio, with extra env. Returns the child's exit code. */
function runTsx(
  ctx: RuntimeContext,
  entry: string,
  env: Record<string, string>,
  args: string[] = [],
): Promise<number> {
  return new Promise((res) => {
    const child = spawn('npx', ['tsx', join(ctx.packageRoot, entry), ...args], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('exit', (code) => res(code ?? 0));
  });
}

/** Spawn `node <entry>` inheriting stdio, with extra env. Used for JS consumers,
 *  where the compiled dist/server runs on plain Node (no tsx child — so it works
 *  inside the codex sandbox). */
function runNode(entry: string, env: Record<string, string>, args: string[] = []): Promise<number> {
  return new Promise((res) => {
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('exit', (code) => res(code ?? 0));
  });
}

/** Launch a server entry ('index' or 'mcp') in the mode the bin decided: plain
 *  `node dist/server/<name>.js` for JS consumers, `tsx server/<name>.ts` otherwise. */
function launchServer(
  ctx: RuntimeContext,
  name: 'index' | 'mcp',
  env: Record<string, string>,
  args: string[] = [],
): Promise<number> {
  if (ctx.runnerMode === 'node') {
    return runNode(join(ctx.packageRoot, 'dist', 'server', `${name}.js`), env, args);
  }
  return runTsx(ctx, join('server', `${name}.ts`), env, args);
}

/** Build (if needed) and launch the studio dev server. Shared by `dev` and by
 *  `init` (which launches after scaffolding unless --no-launch is passed). */
async function runDev(p: ParsedArgs, ctx: RuntimeContext): Promise<number> {
  // Same precedence as bin/runtime.mjs's decideRuntime (EMBERFLOW_PROJECT env →
  // --project flag → cwd) so the launched process boots the same project the
  // runtime decision was made against — a bare --project flag no longer
  // silently overwrites an already-set EMBERFLOW_PROJECT.
  const project = resolveProjectDir(p.project ? ['--project', p.project] : [], process.env, process.cwd());
  // From a consumer install the shipped studio-dist exists; from source it may not.
  if (!existsSync(join(ctx.packageRoot, 'studio-dist'))) {
    console.log('[emberflow] building studio…');
    await runTsx(ctx, 'node_modules/.bin/vite', {}, ['build']).catch(() => 0);
  }
  return launchServer(ctx, 'index', {
    EMBERFLOW_SERVE_STUDIO: '1',
    EMBERFLOW_PROJECT: project,
    // `dev` runs a single (non-watch) process, so opening the browser once
    // is the intended UX. (The server default is off so this repo's watch-mode
    // `npm run server` doesn't spawn a tab per restart — see server/index.ts.)
    EMBERFLOW_OPEN_BROWSER: '1',
    ...(p.port ? { EMBERFLOW_RUNNER_PORT: String(p.port) } : {}),
    ...(p.mock ? { EMBERFLOW_MOCK: '1' } : {}),
  });
}

/** Run the runner headless: API + operation routes, NO studio, NO browser.
 *  This is the production-ish API host — `dev` additionally serves the studio
 *  and opens a browser tab. */
function runServe(p: ParsedArgs, ctx: RuntimeContext): Promise<number> {
  // See runDev's comment: same EMBERFLOW_PROJECT-first precedence as
  // bin/runtime.mjs's resolveProjectDir.
  const project = resolveProjectDir(p.project ? ['--project', p.project] : [], process.env, process.cwd());
  return launchServer(ctx, 'index', {
    EMBERFLOW_PROJECT: project,
    ...(p.port ? { EMBERFLOW_RUNNER_PORT: String(p.port) } : {}),
    ...(p.mock ? { EMBERFLOW_MOCK: '1' } : {}),
  });
}

export async function runCommand(p: ParsedArgs, ctx: RuntimeContext = defaultCtx): Promise<number> {
  const pkgRoot = ctx.packageRoot;
  switch (p.command) {
    case 'dev':
      return runDev(p, ctx);
    case 'serve':
      return runServe(p, ctx);
    case 'mcp':
      return launchServer(ctx, 'mcp', {});
    case 'run': {
      // In-process via tsx's register() loader — NO `tsx` child spawn, so it
      // works inside the codex sandbox (tsx's IPC pipe is blocked there).
      const args = ['run', ...p.rest, ...(p.scenario ? ['--scenario', p.scenario] : [])];
      return (await import('../server/cli')).runCli(args);
    }
    case 'list-nodes':
    case 'node-schema':
    case 'list-workflows':
    case 'get-workflow':
    case 'list-environments':
    case 'login-environment':
    case 'set-environment-auth':
    case 'serving':
    case 'validate':
    case 'publish':
    case 'save':
    case 'samples':
    case 'create':
    case 'delete':
    case 'rename': {
      // Rich CLI operation commands, also in-process (no `tsx` child spawn).
      return (await import('../server/cli')).runCli([p.command, ...p.rest]);
    }
    case 'test': {
      // In-process scenario suite runner — NO runner process. Needs the
      // project dir (server/cli.ts's `test` case reads EMBERFLOW_PROJECT),
      // same convention runDev/runServe use for --project.
      if (p.project) process.env.EMBERFLOW_PROJECT = resolve(process.cwd(), p.project);
      // --mock is parsed globally (dev/serve read it as EMBERFLOW_MOCK), so it
      // never lands in p.rest — thread it through explicitly here.
      return (await import('../server/cli')).runCli(['test', ...p.rest, ...(p.mock ? ['--mock'] : [])]);
    }
    case 'doctor': {
      // In-process operation diagnostics — NO runner process, same
      // EMBERFLOW_PROJECT convention as `test`.
      if (p.project) process.env.EMBERFLOW_PROJECT = resolve(process.cwd(), p.project);
      return (await import('../server/cli')).runCli(['doctor', ...p.rest]);
    }
    case 'init': {
      // bin/init compiles alongside this module (dist/bin/init.js when built),
      // so resolve the guard against THIS module's own location + extension —
      // init.ts under tsx source, init.js under plain-node dist.
      const initExt = import.meta.url.endsWith('.js') ? '.js' : '.ts';
      const initEntry = fileURLToPath(new URL(`./init${initExt}`, import.meta.url));
      if (!existsSync(initEntry)) {
        console.log('emberflow init lands in a later step');
        return 0;
      }
      if (p.js && p.ts) {
        console.error('[emberflow] --js and --ts are mutually exclusive');
        return 1;
      }
      try {
        const mod = (await import('./init')) as {
          runInit: (
            cwd: string,
            opts?: {
              skills?: false | { scope: 'repo' | 'global'; home: string };
              packageRoot?: string;
              language?: 'javascript' | 'typescript';
            }
          ) => Promise<number>;
          tsxResolvable: (cwd: string) => boolean;
        };
        const scope = p.scope ?? (await promptScope());
        const language = p.js ? 'javascript' : p.ts ? 'typescript' : await promptLanguage();
        const code = await mod.runInit(
          process.cwd(),
          p.noSkills
            ? { skills: false, packageRoot: pkgRoot, language }
            : { skills: { scope, home: homedir() }, packageRoot: pkgRoot, language }
        );
        if (code !== 0) return code;

        console.log('');
        console.log('[emberflow] next steps:');
        console.log('  - run `npx emberflow dev` any time to relaunch the studio');
        console.log(
          p.noSkills
            ? '  - skills were not installed (--no-skills)'
            : `  - skills installed at ${scope === 'global' ? '~' : '.'}/.claude (and/or .codex) /skills`
        );
        console.log('  - your operations live in emberflow/apis (open the studio to build them)');
        console.log('');

        if (p.noLaunch) return 0;

        // `ctx` reflects the runtime decision made at bin startup — BEFORE
        // scaffolding existed. For a fresh TS project that decision was made with
        // no config on disk (→ node mode), which then dies launching against the
        // just-scaffolded emberflow.config.ts. Re-decide against the now-real
        // project instead of trusting the stale context.
        if (language === 'typescript') {
          if (!mod.tsxResolvable(process.cwd())) {
            console.log('');
            console.log('[emberflow] tsx is not installed — skipping auto-launch.');
            console.log('  npm i -D tsx typescript');
            console.log('  npx emberflow dev');
            return 0;
          }
          const decision = decideRuntime({ packageRoot: pkgRoot, projectDir: process.cwd(), env: process.env });
          console.log('[emberflow] Starting Emberflow…');
          return runDev(p, { runnerMode: decision.runnerMode as 'node' | 'tsx', packageRoot: pkgRoot });
        }

        console.log('[emberflow] Starting Emberflow…');
        return runDev(p, ctx);
      } catch (err) {
        console.error('[emberflow] init failed:', err instanceof Error ? err.message : err);
        return 1;
      }
    }
    default:
      console.log(
        'Usage: emberflow <dev|serve|mcp|init|run|test|doctor|list-nodes|node-schema|list-workflows|get-workflow|list-environments|login-environment|set-environment-auth|serving|validate|publish|save|create|delete|rename|samples> [--port N] [--project DIR] [--scenario NAME] [--no-skills] [--global|--local] [--no-launch] [--mock] [--js|--ts]\n' +
          '  test [opId] [--environment NAME] [--json]   Run scenario expectations in-process (no runner) — exit 0/1/2\n' +
          '  doctor [opId] [--fix]                       Diagnose operation(s) in-process (no runner); --fix seeds param defaults — exit 0/1/2'
      );
      return 0;
  }
}
