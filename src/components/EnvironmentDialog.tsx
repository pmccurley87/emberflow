import { useState } from 'react';
import { Loader2Icon, PlusIcon, ShieldIcon, SparklesIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useBuilderStore } from '../store/builderStore';
import type { EnvAuth, EnvironmentSummary } from '../store/serverRunner';

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
      {children}
    </div>
  );
}

/** Inline error line shared by the dialog's sections. */
function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="text-[11.5px] text-destructive">{message}</div>;
}

/**
 * Secrets manager: stored values are write-only — the dialog shows key names
 * and a set/unset state, never a value. New values go straight to the runner
 * (PUT …/secrets/:key) and exist in studio memory only for the duration of
 * the call.
 */
function SecretsSection({ env }: { env: EnvironmentSummary }) {
  const setEnvironmentSecret = useBuilderStore((s) => s.setEnvironmentSecret);
  const deleteEnvironmentSecret = useBuilderStore((s) => s.deleteEnvironmentSecret);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [pending, setPending] = useState<string | null>(null); // key being written/cleared
  const [error, setError] = useState<string | null>(null);

  const onSet = async () => {
    const k = key.trim();
    if (!k || !value) return;
    setError(null);
    setPending(k);
    try {
      await setEnvironmentSecret(env.name, k, value);
      setKey('');
      setValue('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set secret');
    } finally {
      setPending(null);
    }
  };

  const onClear = async (k: string) => {
    setError(null);
    setPending(k);
    try {
      await deleteEnvironmentSecret(env.name, k);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear secret');
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>Secrets</SectionTitle>
      {env.secretKeys.length === 0 && (
        <div className="text-[11.5px] text-muted-foreground">No secrets stored.</div>
      )}
      {env.secretKeys.map((k) => (
        <div key={k} className="flex items-center gap-2 text-[12px]">
          <span className="min-w-0 truncate font-mono">{k}</span>
          <span className="text-muted-foreground">••••••</span>
          <button
            type="button"
            onClick={() => void onClear(k)}
            disabled={pending === k}
            title={`Clear ${k}`}
            className="ml-auto cursor-pointer rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
          >
            {pending === k ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : (
              <XIcon className="size-3" />
            )}
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="key"
          spellCheck={false}
          className="h-7 flex-1 font-mono text-[12px]"
        />
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value"
          type="password"
          autoComplete="off"
          className="h-7 flex-1 text-[12px]"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onSet();
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          className="h-7"
          disabled={!key.trim() || !value || pending !== null}
          onClick={() => void onSet()}
        >
          <PlusIcon className="size-3" />
          Set
        </Button>
      </div>
      <ErrorLine message={error} />
    </div>
  );
}

/** Blank form state derived from an existing config (or sensible defaults). */
function formFromConfig(config: EnvAuth | undefined) {
  return {
    attachAs: config?.attach.as ?? ('cookie' as 'cookie' | 'header'),
    attachName: config?.attach.name ?? '',
    secretRef: config?.attach.secretRef ?? '',
    prefix: config?.attach.prefix ?? '',
    hasLogin: !!config?.login,
    loginMethod: config?.login?.request.method ?? 'POST',
    loginUrl: config?.login?.request.url ?? '',
    loginHeaders: config?.login?.request.headers
      ? JSON.stringify(config.login.request.headers, null, 2)
      : '',
    bodyRef: config?.login?.request.bodyRef ?? '',
    captureFrom: (config?.login?.capture.from ?? 'set-cookie') as 'set-cookie' | 'json' | 'header',
    captureField:
      config?.login?.capture.from === 'set-cookie'
        ? (config.login.capture.cookieName ?? '')
        : config?.login?.capture.from === 'json'
          ? config.login.capture.path
          : config?.login?.capture.from === 'header'
            ? config.login.capture.name
            : '',
  };
}

const fieldLabel = 'w-24 shrink-0 text-[11px] text-muted-foreground';
const fieldRow = 'flex items-center gap-2';
const selectCls =
  'h-7 rounded-md border border-input bg-transparent px-2 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring';

/**
 * Auth configuration: maps 1:1 to the runner's EnvAuth shape. Values here are
 * config (names/refs), never credentials — the one sharp edge is login
 * headers, which round-trip through GET /environments, so we warn against
 * putting secrets there.
 */
function AuthSection({ env }: { env: EnvironmentSummary }) {
  const setEnvironmentAuth = useBuilderStore((s) => s.setEnvironmentAuth);
  const loginEnvironment = useBuilderStore((s) => s.loginEnvironment);
  const runAgent = useBuilderStore((s) => s.runAgent);
  const configured = env.auth?.configured ?? false;
  const [editing, setEditing] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState('');
  const [form, setForm] = useState(() => formFromConfig(env.auth?.config));
  const [pending, setPending] = useState<'save' | 'clear' | 'login' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loginResult, setLoginResult] = useState<string | null>(null);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const buildAuth = (): EnvAuth | { error: string } => {
    if (!form.attachName.trim()) return { error: 'Attach name is required' };
    if (!form.secretRef.trim()) return { error: 'Secret ref is required' };
    const auth: EnvAuth = {
      attach: {
        as: form.attachAs,
        name: form.attachName.trim(),
        secretRef: form.secretRef.trim(),
        ...(form.prefix ? { prefix: form.prefix } : {}),
      },
    };
    if (form.hasLogin) {
      if (!form.loginUrl.trim()) return { error: 'Login URL is required' };
      let headers: Record<string, string> | undefined;
      if (form.loginHeaders.trim()) {
        try {
          headers = JSON.parse(form.loginHeaders) as Record<string, string>;
        } catch {
          return { error: 'Login headers must be valid JSON' };
        }
      }
      const field = form.captureField.trim();
      auth.login = {
        request: {
          method: form.loginMethod.trim() || 'POST',
          url: form.loginUrl.trim(),
          ...(headers ? { headers } : {}),
          ...(form.bodyRef.trim() ? { bodyRef: form.bodyRef.trim() } : {}),
        },
        capture:
          form.captureFrom === 'set-cookie'
            ? { from: 'set-cookie', ...(field ? { cookieName: field } : {}) }
            : form.captureFrom === 'json'
              ? { from: 'json', path: field }
              : { from: 'header', name: field },
      };
    }
    return auth;
  };

  const onSave = async () => {
    const auth = buildAuth();
    if ('error' in auth) {
      setError(auth.error);
      return;
    }
    setError(null);
    setPending('save');
    try {
      await setEnvironmentAuth(env.name, auth);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save auth config');
    } finally {
      setPending(null);
    }
  };

  const onClearAuth = async () => {
    setError(null);
    setPending('clear');
    try {
      await setEnvironmentAuth(env.name, null);
      setEditing(false);
      setForm(formFromConfig(undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear auth config');
    } finally {
      setPending(null);
    }
  };

  const onLogin = async () => {
    setError(null);
    setLoginResult(null);
    setPending('login');
    try {
      await loginEnvironment(env.name);
      setLoginResult('Logged in.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setPending(null);
    }
  };

  const onSetupWithAi = () => {
    const instruction = aiInstruction.trim();
    if (!instruction) return;
    void runAgent({ action: 'setup-auth', environment: env.name, instruction });
    setAiOpen(false);
    setAiInstruction('');
  };

  const summary = env.auth?.config
    ? `${env.auth.config.attach.as} · ${env.auth.config.attach.name} ← «${env.auth.config.attach.secretRef}»${env.auth.config.login ? ` · login ${env.auth.config.login.request.method} ${env.auth.config.login.request.url}` : ''}`
    : null;

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>Auth</SectionTitle>

      {!configured && !editing && !aiOpen && (
        <div className="flex flex-col gap-2">
          <div className="text-[11.5px] text-muted-foreground">
            No auth configured — runs against this environment carry no credential.
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" className="h-7" onClick={() => setAiOpen(true)}>
              <SparklesIcon className="size-3" />
              Set up with AI
            </Button>
            <Button variant="ghost" size="sm" className="h-7" onClick={() => setEditing(true)}>
              Configure manually
            </Button>
          </div>
        </div>
      )}

      {aiOpen && (
        <div className="flex flex-col gap-2">
          <textarea
            value={aiInstruction}
            onChange={(e) => setAiInstruction(e.target.value)}
            placeholder={
              'Describe how this API logs in — paste a curl, name the endpoint, say where the token/cookie comes back…'
            }
            rows={4}
            className="w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-[12px] outline-none placeholder:text-muted-foreground/60 focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="text-[11px] text-muted-foreground">
            The agent writes the config and verifies the login. It never sees credential values —
            you'll enter those here as secrets.
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" className="h-7" onClick={() => setAiOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="h-7"
              disabled={!aiInstruction.trim()}
              onClick={onSetupWithAi}
            >
              <SparklesIcon className="size-3" />
              Start
            </Button>
          </div>
        </div>
      )}

      {configured && !editing && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-[12px]">
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                env.auth?.authenticated ? 'bg-success' : 'border border-muted-foreground',
              )}
            />
            <span className="min-w-0 truncate font-mono text-[11.5px]">{summary}</span>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="h-7"
              disabled={pending !== null}
              onClick={() => void onLogin()}
            >
              {pending === 'login' && <Loader2Icon className="size-3 animate-spin" />}
              {env.auth?.authenticated ? 'Re-log in' : 'Log in'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={() => {
                setForm(formFromConfig(env.auth?.config));
                setEditing(true);
              }}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-destructive hover:text-destructive"
              disabled={pending !== null}
              onClick={() => void onClearAuth()}
            >
              {pending === 'clear' && <Loader2Icon className="size-3 animate-spin" />}
              Remove
            </Button>
          </div>
          {loginResult && <div className="text-[11.5px] text-success">{loginResult}</div>}
        </div>
      )}

      {editing && (
        <div className="flex flex-col gap-2">
          <div className={fieldRow}>
            <span className={fieldLabel}>Attach as</span>
            <select
              value={form.attachAs}
              onChange={(e) => set('attachAs', e.target.value as 'cookie' | 'header')}
              className={selectCls}
            >
              <option value="cookie">cookie</option>
              <option value="header">header</option>
            </select>
            <Input
              value={form.attachName}
              onChange={(e) => set('attachName', e.target.value)}
              placeholder={form.attachAs === 'cookie' ? 'cookie name' : 'header name'}
              spellCheck={false}
              className="h-7 flex-1 font-mono text-[12px]"
            />
          </div>
          <div className={fieldRow}>
            <span className={fieldLabel}>Secret ref</span>
            <Input
              value={form.secretRef}
              onChange={(e) => set('secretRef', e.target.value)}
              placeholder="secret key holding the credential"
              spellCheck={false}
              className="h-7 flex-1 font-mono text-[12px]"
            />
          </div>
          <div className={fieldRow}>
            <span className={fieldLabel}>Prefix</span>
            <Input
              value={form.prefix}
              onChange={(e) => set('prefix', e.target.value)}
              placeholder='optional, e.g. "Bearer "'
              className="h-7 flex-1 font-mono text-[12px]"
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={form.hasLogin}
              onChange={(e) => set('hasLogin', e.target.checked)}
            />
            Login request mints the credential
          </label>

          {form.hasLogin && (
            <>
              <div className={fieldRow}>
                <span className={fieldLabel}>Login</span>
                <Input
                  value={form.loginMethod}
                  onChange={(e) => set('loginMethod', e.target.value)}
                  className="h-7 w-20 font-mono text-[12px]"
                  spellCheck={false}
                />
                <Input
                  value={form.loginUrl}
                  onChange={(e) => set('loginUrl', e.target.value)}
                  placeholder="https://…/login"
                  spellCheck={false}
                  className="h-7 flex-1 font-mono text-[12px]"
                />
              </div>
              <div className={fieldRow}>
                <span className={fieldLabel}>Body secret</span>
                <Input
                  value={form.bodyRef}
                  onChange={(e) => set('bodyRef', e.target.value)}
                  placeholder="secret key holding the login body JSON"
                  spellCheck={false}
                  className="h-7 flex-1 font-mono text-[12px]"
                />
              </div>
              <div className="flex items-start gap-2">
                <span className={cn(fieldLabel, 'pt-1.5')}>Headers</span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <textarea
                    value={form.loginHeaders}
                    onChange={(e) => set('loginHeaders', e.target.value)}
                    placeholder='{"origin": "http://localhost:5173"}'
                    rows={2}
                    spellCheck={false}
                    className="w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 font-mono text-[11.5px] outline-none placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-ring"
                  />
                  <div className="text-[10.5px] text-muted-foreground">
                    Config only — never put credentials here; use the body secret instead.
                  </div>
                </div>
              </div>
              <div className={fieldRow}>
                <span className={fieldLabel}>Capture</span>
                <select
                  value={form.captureFrom}
                  onChange={(e) =>
                    set('captureFrom', e.target.value as 'set-cookie' | 'json' | 'header')
                  }
                  className={selectCls}
                >
                  <option value="set-cookie">set-cookie</option>
                  <option value="json">json path</option>
                  <option value="header">header</option>
                </select>
                <Input
                  value={form.captureField}
                  onChange={(e) => set('captureField', e.target.value)}
                  placeholder={
                    form.captureFrom === 'set-cookie'
                      ? 'cookie name (optional)'
                      : form.captureFrom === 'json'
                        ? 'dot.path.to.token'
                        : 'header name'
                  }
                  spellCheck={false}
                  className="h-7 flex-1 font-mono text-[12px]"
                />
              </div>
            </>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" className="h-7" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="h-7"
              disabled={pending !== null}
              onClick={() => void onSave()}
            >
              {pending === 'save' && <Loader2Icon className="size-3 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      )}

      <ErrorLine message={error} />
    </div>
  );
}

/**
 * Manage Environment dialog: secrets (write-only), auth config, and login —
 * everything that previously required hand-editing emberflow.environments.json.
 */
export function EnvironmentDialog({
  env,
  open,
  onOpenChange,
}: {
  env: EnvironmentSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!env) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle className="flex items-center gap-2">
          {env.name}
          {env.protected && (
            <span
              title="Protected — runs ask for confirmation before touching this environment."
              className="flex items-center gap-1 text-[10.5px] font-normal uppercase tracking-wide text-destructive-foreground/80"
            >
              <ShieldIcon className="size-3" /> protected
            </span>
          )}
          {env.auth?.configured && (
            <span
              className={cn(
                'ml-auto size-1.5 rounded-full',
                env.auth.authenticated ? 'bg-success' : 'border border-muted-foreground',
              )}
              title={env.auth.authenticated ? 'Authenticated' : 'Not authenticated'}
            />
          )}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Manage secrets and auth for the {env.name} environment.
        </DialogDescription>
        <div className="flex flex-col gap-5">
          <SecretsSection env={env} />
          <AuthSection env={env} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
