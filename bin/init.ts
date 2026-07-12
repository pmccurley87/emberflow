import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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

  const skillsOpt = opts?.skills === undefined ? { scope: 'repo' as const, home: homedir() } : opts.skills;
  if (skillsOpt !== false) {
    const pkgRoot = opts?.packageRoot ?? join(dirname(fileURLToPath(import.meta.url)), '..');
    const skillsSrc = join(pkgRoot, 'templates', 'skills');
    if (existsSync(skillsSrc)) {
      const presence = detectHarnesses(cwd, skillsOpt.home);
      const skillDirs = resolveSkillDirs(presence, skillsOpt.scope, cwd, skillsOpt.home);
      const skillsWritten: string[] = [];
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

  return 0;
}
