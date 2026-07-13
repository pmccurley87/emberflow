import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectHarnesses, resolveSkillDirs } from './skillTargets';

const MCP_SNIPPET = {
  mcpServers: {
    emberflow: { command: 'npx', args: ['emberflow', 'mcp'] },
  },
};

function copySkillsRecursive(src: string, dest: string, log: string[]): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copySkillsRecursive(srcPath, destPath, log);
    } else if (!existsSync(destPath)) {
      copyFileSync(srcPath, destPath);
      log.push(destPath);
    }
  }
}

const JS_CONFIG_CONTENT =
  "import { defineConfig } from '@xdelivered/emberflow';\n\n" +
  'export default defineConfig({\n' +
  "  language: 'javascript',\n" +
  '  // Anchor only: this path is never created and holds no files. It just tells\n' +
  '  // Emberflow where your project root is — operations always live in the\n' +
  '  // SIBLING apis/ tree next to it:\n' +
  '  //   emberflow/apis/<api>/<folder…>/<op>.json — each op id = its path under apis/.\n' +
  "  flowsDir: 'emberflow/flows',\n" +
  '  // Author your nodes here: registry.register(definition, async (ctx) => output).\n' +
  "  /** @param {import('@xdelivered/emberflow').NodeRegistry} registry */\n" +
  '  registerNodes(registry) {\n' +
  '    /* register your nodes */\n' +
  '  },\n' +
  '});\n';

const TS_CONFIG_CONTENT =
  "import { defineConfig } from '@xdelivered/emberflow';\n" +
  "import type { NodeRegistry } from '@xdelivered/emberflow';\n\n" +
  'export default defineConfig({\n' +
  "  language: 'typescript',\n" +
  '  // Anchor only: this path is never created and holds no files. It just tells\n' +
  '  // Emberflow where your project root is — operations always live in the\n' +
  '  // SIBLING apis/ tree next to it:\n' +
  '  //   emberflow/apis/<api>/<folder…>/<op>.json — each op id = its path under apis/.\n' +
  "  flowsDir: 'emberflow/flows',\n" +
  '  // Author your nodes here: registry.register(definition, async (ctx) => output).\n' +
  '  registerNodes(registry: NodeRegistry) {\n' +
  '    /* register your nodes */\n' +
  '  },\n' +
  '});\n';

// Minimal — the consumer only needs their config + nodes typechecked, not a full
// project tsconfig. `noEmit` because emberflow.config.ts runs via tsx, never tsc.
const TSCONFIG_CONTENT =
  JSON.stringify(
    {
      compilerOptions: {
        target: 'es2022',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        strict: true,
        skipLibCheck: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        noEmit: true,
      },
      include: ['emberflow.config.ts', 'emberflow/**/*'],
    },
    null,
    2
  ) + '\n';

/** Whether `tsx` resolves from the project's own node_modules (peer dep — optional).
 *  Exported so bin/commands.ts can reuse it when deciding whether `init --ts` can
 *  launch dev immediately after scaffolding, or must defer to the user. */
export function tsxResolvable(cwd: string): boolean {
  try {
    createRequire(join(cwd, 'package.json')).resolve('tsx');
    return true;
  } catch {
    return false;
  }
}

// The example HTTP operation: GET /hello, Input({params,query,body,headers}) →
// Response({status,body}). Its `id` equals its path under the apis dir.
const HELLO_OP = {
  id: 'default/hello',
  name: 'Hello',
  version: 1,
  http: { method: 'GET', path: '/hello' },
  nodes: [
    {
      id: 'input',
      type: 'Input',
      label: 'Request',
      position: { x: 0, y: 0 },
      config: {
        fields: [
          { name: 'params', type: 'object' },
          { name: 'query', type: 'object' },
          { name: 'body', type: 'object' },
          { name: 'headers', type: 'object' },
        ],
        defaults: { query: { name: 'world' } },
      },
    },
    {
      id: 'response',
      type: 'Response',
      label: 'Response',
      position: { x: 300, y: 0 },
      config: {},
      inputMap: {
        body: { sourceNodeId: 'input', sourceField: 'query' },
      },
    },
  ],
  edges: [{ id: 'e0', source: 'input', target: 'response', targetHandle: 'body' }],
  createdAt: '2026-07-05T00:00:00Z',
  updatedAt: '2026-07-05T00:00:00Z',
};

const HELLO_OP_SCENARIOS = [{ id: 's-hi', name: 'greet', input: { query: { name: 'Ember' } } }];

// Emberflow infra that is machine-local, generated, or secret — never committed.
// NOTE: emberflow.config.mjs and emberflow/ (apis + scenarios) are deliberately
// NOT here — those are the value and SHOULD be checked in.
const GITIGNORE_HEADER = '# Emberflow (local infra — emberflow.config.mjs and emberflow/apis ARE committed)';
const GITIGNORE_LINES = [
  'node_modules/',
  'studio-dist/',
  'emberflow.secrets.json',
  'emberflow.environments.json',
];

function writeFileIfAbsent(path: string, content: string, log: string[]): void {
  if (existsSync(path)) return;
  writeFileSync(path, content);
  log.push(path);
}

/** Same notion as server/agents/gitScope.ts's isGitRepo: is `cwd` inside a git
 *  work tree? A plain rev-parse probe — we only need the yes/no. */
function isInsideGitRepo(cwd: string): boolean {
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

/**
 * Every agent feature is gated on git: AgentRunManager snapshots the tree with
 * git so changes can be reviewed and reverted (server/agents/runManager.ts).
 * Nothing else creates the repo, so a freshly-`init`ed folder that isn't already
 * inside a repo gets one here, with an initial commit of ONLY the files init
 * scaffolded — never `git add -A`, since a fresh dir may already hold the user's
 * own uncommitted app code.
 *
 * The initial commit is load-bearing, not cosmetic: gitScope restores tracked
 * files by checking them out of the snapshot commit, and an unborn HEAD (a repo
 * with zero commits) leaves `snapshot.head` null — so agent edits to any
 * pre-existing tracked file could not be reverted. The commit gives the safety
 * net something to diff/revert against.
 *
 * Never nests a repo or commits when already inside one. Returns a one-line
 * human summary of what happened, or null when nothing was done.
 */
function initGitRepo(cwd: string, scaffolded: string[]): string | null {
  if (isInsideGitRepo(cwd)) return null; // pre-existing repo — never nest, never commit

  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
  };

  git(['init']);

  // Commit ONLY init's own scaffold, by explicit relative path — not `-A`.
  const paths = [
    ...new Set(
      scaffolded
        .map((p) => relative(cwd, p.replace(/\/+$/, '')))
        .filter((p) => p.length > 0 && existsSync(join(cwd, p))),
    ),
  ];
  if (paths.length === 0) {
    // No scaffolded files to commit — most likely a re-run of init on a
    // directory it already scaffolded (e.g. the checklist's copyable skills
    // command, run non-interactively, against an existing project). `git init`
    // alone leaves HEAD unborn, which breaks the agent snapshot safety net
    // (gitScope reads snapshot.head as null and treats all later edits as
    // unrevertable) while the git checklist row reports green. An empty anchor
    // commit gives HEAD a real target with zero files tracked.
    const commitEmpty = (extra: string[]): void =>
      git([...extra, 'commit', '--allow-empty', '-m', 'chore: emberflow init (anchor)']);
    try {
      commitEmpty([]);
    } catch {
      commitEmpty(['-c', 'user.name=Emberflow', '-c', 'user.email=emberflow@localhost']);
    }
    return 'initialized a git repository with an empty anchor commit (no scaffolded files to commit)';
  }

  git(['add', '--', ...paths]);
  const commit = (extra: string[]): void => git([...extra, 'commit', '-m', 'chore: emberflow init']);
  try {
    commit([]);
  } catch {
    // No user.name/user.email configured (fresh machine, CI) — the commit is
    // load-bearing for the agent snapshot safety net, so fall back to a one-off
    // identity for THIS commit only rather than fail init.
    commit(['-c', 'user.name=Emberflow', '-c', 'user.email=emberflow@localhost']);
  }
  return 'initialized a git repository and committed the scaffold (chore: emberflow init)';
}

export async function runInit(
  cwd: string,
  opts?: {
    skills?: false | { scope: 'repo' | 'global'; home: string };
    /** Real package root, passed by the bin. Falls back to this module's own
     *  location — which is wrong when compiled to dist/bin/init.js (its `..` is
     *  dist/, not the package root that holds templates/), so the bin supplies it. */
    packageRoot?: string;
    /** Which language to scaffold the config/nodes in. Defaults to javascript
     *  (matches the non-TTY prompt default in bin/commands.ts). */
    language?: 'javascript' | 'typescript';
    /** Create a git repo + initial commit when the target isn't already inside
     *  one (agent features need it — see initGitRepo). Defaults to true; the
     *  `--no-git` flag threads through as false. */
    git?: boolean;
  }
): Promise<number> {
  const written: string[] = [];
  const language = opts?.language ?? 'javascript';

  // Refuse to scaffold a SECOND config in another extension: the loader probes
  // .mjs before .js before .ts, so a new config of a different flavor would sit
  // dead on disk while init claims success. Language switching is a manual
  // migration (rename/port the existing config), not a re-init.
  const existingOther = ['emberflow.config.mjs', 'emberflow.config.js', 'emberflow.config.ts']
    .filter((name) => (language === 'typescript' ? !name.endsWith('.ts') : name.endsWith('.ts')))
    .find((name) => existsSync(join(cwd, name)));
  if (existingOther) {
    console.error(
      `[emberflow] this project already has ${existingOther} — refusing to scaffold a ${language} config alongside it. ` +
        `To switch languages, port ${existingOther} manually and delete it.`,
    );
    return 1;
  }

  if (language === 'typescript') {
    writeFileIfAbsent(join(cwd, 'emberflow.config.ts'), TS_CONFIG_CONTENT, written);
    writeFileIfAbsent(join(cwd, 'tsconfig.json'), TSCONFIG_CONTENT, written);
    if (!tsxResolvable(cwd)) {
      console.log('[emberflow] TypeScript config needs tsx to run this project.');
      console.log('  npm i -D tsx typescript');
    }
  } else {
    writeFileIfAbsent(join(cwd, 'emberflow.config.mjs'), JS_CONFIG_CONTENT, written);
  }

  // Scaffold the apis/ tree with an example HTTP operation so the API host has a
  // routed endpoint the moment the project boots. The operation's `id`
  // ("default/hello") equals its path under the apis dir.
  const apisDefaultDir = join(cwd, 'emberflow', 'apis', 'default');
  const apisDefaultDirExisted = existsSync(apisDefaultDir);
  mkdirSync(apisDefaultDir, { recursive: true });
  if (!apisDefaultDirExisted) written.push(apisDefaultDir + '/');

  writeFileIfAbsent(
    join(apisDefaultDir, 'hello.json'),
    JSON.stringify(HELLO_OP, null, 2) + '\n',
    written
  );
  writeFileIfAbsent(
    join(apisDefaultDir, 'hello.scenarios.json'),
    JSON.stringify(HELLO_OP_SCENARIOS, null, 2) + '\n',
    written
  );

  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>;
      type?: string;
      [key: string]: unknown;
    };
    let pkgDirty = false;
    if (!pkg.scripts) pkg.scripts = {};
    if (!pkg.scripts.emberflow) {
      pkg.scripts.emberflow = 'emberflow dev';
      pkgDirty = true;
    }
    // A TypeScript project MUST load as ESM: `emberflow` is an ESM-only package,
    // and under a CommonJS package.json tsx transpiles emberflow.config.ts to CJS
    // and then require()s the ESM `emberflow` — which Node rejects with
    // ERR_REQUIRE_CYCLE_MODULE. Stamp "type":"module" when the project hasn't
    // declared one. (JS scaffolds a .mjs config, which is ESM regardless.)
    if (language === 'typescript') {
      if (pkg.type === undefined) {
        pkg.type = 'module';
        pkgDirty = true;
        console.warn(
          '[emberflow] set "type": "module" in package.json — required for emberflow.config.ts; ' +
            'if this project has existing CommonJS .js files, audit them (they are now parsed as ESM)',
        );
      } else if (pkg.type !== 'module') {
        console.warn(
          `[emberflow] warning: package.json has "type": "${pkg.type}", but a TypeScript ` +
            'emberflow.config.ts must load as ESM. Set "type": "module" or the runner will fail ' +
            'to load your config.',
        );
      }
    }
    if (pkgDirty) {
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      written.push(pkgPath);
    }
  }

  const gitignorePath = join(cwd, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const missing = GITIGNORE_LINES.filter((line) => !existing.includes(line));
  if (missing.length > 0) {
    // Create .gitignore if absent, or append only the lines not already present.
    const header = existing.includes(GITIGNORE_HEADER) ? '' : `${GITIGNORE_HEADER}\n`;
    const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    const block = (existing.length > 0 ? '\n' : '') + header + missing.join('\n') + '\n';
    writeFileSync(gitignorePath, existing + sep + block);
    written.push(gitignorePath);
  }

  for (const path of written) {
    console.log(`[emberflow] created ${path}`);
  }

  // Skills are copied BEFORE the git init/commit below so repo-scope skill
  // files (e.g. .claude/skills/emberflow-basics/SKILL.md) land in the same
  // scaffold commit instead of being left untracked.
  let skillsWritten: string[] = [];
  const skillsOpt = opts?.skills === undefined ? { scope: 'repo' as const, home: homedir() } : opts.skills;
  if (skillsOpt !== false) {
    const pkgRoot = opts?.packageRoot ?? join(dirname(fileURLToPath(import.meta.url)), '..');
    const skillsSrc = join(pkgRoot, 'templates', 'skills');
    if (existsSync(skillsSrc)) {
      const presence = detectHarnesses(cwd, skillsOpt.home);
      const skillDirs = resolveSkillDirs(presence, skillsOpt.scope, cwd, skillsOpt.home);
      for (const dir of skillDirs) {
        copySkillsRecursive(skillsSrc, dir, skillsWritten);
      }
      for (const path of skillsWritten) {
        console.log(`[emberflow] created ${path}`);
      }
    }
    console.log('');
    console.log(
      '[emberflow] To let your agent drive Emberflow directly, register the emberflow MCP server:'
    );
    console.log(
      "  - Claude Code: add the snippet below to .mcp.json at your project root."
    );
    console.log(
      "  - Other agents: add it to your agent's MCP server config (name/location varies by tool)."
    );
    console.log(JSON.stringify(MCP_SNIPPET, null, 2));
  }

  // Agent features (snapshot/diff/revert) require git — create the repo + an
  // initial commit of just the scaffold unless the user opted out or is already
  // inside a repo. Best-effort: a git failure must never fail `init` itself.
  if (opts?.git !== false) {
    try {
      // A `--global` skills install writes into the user's homedir, not the
      // project — only fold in skill paths that actually live under cwd.
      const repoScopeSkills = skillsWritten.filter((p) => !relative(cwd, p).startsWith('..'));
      const summary = initGitRepo(cwd, [...written, ...repoScopeSkills]);
      if (summary) console.log(`[emberflow] ${summary}`);
    } catch (err) {
      console.warn(
        `[emberflow] could not initialize git (agent features need a repo — run \`git init && git add -A && git commit -m "initial"\`): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return 0;
}
