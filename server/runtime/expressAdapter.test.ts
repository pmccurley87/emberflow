import { afterEach, describe, expect, it } from 'vitest';
import { ExpressAdapter } from './expressAdapter';

describe('ExpressAdapter', () => {
  let adapter: ExpressAdapter | undefined;

  afterEach(async () => {
    await adapter?.close();
    adapter = undefined;
  });

  it('registers an operation route and serves it', async () => {
    adapter = new ExpressAdapter();
    adapter.registerOperation({ method: 'GET', path: '/ping' }, (_req, res) => res.json({ pong: true }));
    await adapter.listen(0, '127.0.0.1');
    const port = adapter.address?.port;
    expect(port).toBeTypeOf('number');

    const res = await fetch(`http://127.0.0.1:${port}/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });

  it('throws on a duplicate method+path', () => {
    adapter = new ExpressAdapter();
    const h = (_req: never, res: { end: () => void }) => res.end();
    adapter.registerOperation({ method: 'POST', path: '/x' }, h as never);
    expect(() => adapter?.registerOperation({ method: 'POST', path: '/x' }, h as never)).toThrow(/POST \/x/);
  });

  it('resolves listen/close cleanly', async () => {
    adapter = new ExpressAdapter();
    await adapter.listen(0, '127.0.0.1');
    expect(adapter.address).not.toBeNull();
    await adapter.close();
    expect(adapter.address).toBeNull();
  });
});
