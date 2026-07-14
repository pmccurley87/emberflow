import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NodeCodeView, SourceNavigator } from './SourceNavigator';
import type { SourceFileFetchResult, SourceFilePayload } from '../store/sourceNavClient';

// Props-driven fixtures: renderToStaticMarkup never runs effects, so the
// fetch cache is pre-populated via initialFiles and the fetcher is inert.
const neverFetch = () => new Promise<SourceFileFetchResult>(() => {});

const NODES_MJS: SourceFilePayload = {
  path: 'nodes.mjs',
  content: [
    "import { deriveTrackingActual } from './shipment-logic.mjs';",
    "import express from 'express';",
    "import { createHash } from 'node:crypto';",
    'const RATE = 1.2;',
    'export function handler(input) {',
    '  return deriveTrackingActual(input) * RATE;',
    '}',
  ].join('\n'),
  language: 'js',
  symbols: {
    declarations: [
      { name: 'RATE', kind: 'const', line: 4, endLine: 4, exported: false },
      { name: 'handler', kind: 'fn', line: 5, endLine: 7, exported: true },
    ],
    imports: [
      {
        name: 'deriveTrackingActual',
        local: 'deriveTrackingActual',
        from: './shipment-logic.mjs',
        resolution: { kind: 'project', path: 'shipment-logic.mjs', line: 5 },
      },
      {
        name: 'default',
        local: 'express',
        from: 'express',
        resolution: { kind: 'external', package: 'express' },
      },
      {
        name: 'createHash',
        local: 'createHash',
        from: 'node:crypto',
        resolution: { kind: 'builtin' },
      },
      {
        name: 'import()',
        local: '',
        from: 'x',
        resolution: { kind: 'unresolved', reason: 'dynamic import target is computed' },
      },
      {
        name: '*',
        local: '',
        from: './polyfill.mjs',
        resolution: { kind: 'project', path: 'polyfill.mjs' },
      },
    ],
    reexports: [],
  },
};

const SHIPMENT_MJS: SourceFilePayload = {
  path: 'shipment-logic.mjs',
  content: 'export function deriveTrackingActual(input) { return input.actual; }',
  language: 'js',
  symbols: {
    declarations: [
      { name: 'deriveTrackingActual', kind: 'fn', line: 1, endLine: 1, exported: true },
    ],
    imports: [],
    reexports: [],
  },
};

const files = (payload: SourceFilePayload): Record<string, SourceFileFetchResult> => ({
  [payload.path]: { ok: true, payload },
});

/** Highlighting splits code across token spans; strip tags to assert on the raw text. */
const text = (html: string): string => html.replace(/<[^>]+>/g, '');

describe('SourceNavigator', () => {
  it('renders the file content with local declarations linkified for same-file navigation', () => {
    const out = renderToStaticMarkup(
      <SourceNavigator
        entryFile="nodes.mjs"
        entryLine={5}
        nodeType="DeriveShipmentActuals"
        fetcher={neverFetch}
        initialFiles={files(NODES_MJS)}
      />,
    );
    expect(out).toContain('deriveTrackingActual');
    expect(out).toContain('RATE');
    // Declaration + import identifiers render as link buttons (token linking).
    expect(out).toContain('source-nav-link');
    expect(out).toContain('Jump to line 5'); // handler declaration
    expect(out).toContain('Open shipment-logic.mjs:5'); // project import token
  });

  it('renders a project import as a clickable path:line link in the Referenced code panel', () => {
    const out = renderToStaticMarkup(
      <SourceNavigator
        entryFile="nodes.mjs"
        nodeType="DeriveShipmentActuals"
        fetcher={neverFetch}
        initialFiles={files(NODES_MJS)}
      />,
    );
    expect(out).toContain('Referenced code');
    expect(out).toContain('shipment-logic.mjs:5');
    expect(out).toContain('project');
  });

  it('badges external, builtin, and unresolved (with reason) references', () => {
    const out = renderToStaticMarkup(
      <SourceNavigator
        entryFile="nodes.mjs"
        nodeType="DeriveShipmentActuals"
        fetcher={neverFetch}
        initialFiles={files(NODES_MJS)}
      />,
    );
    expect(out).toContain('package: express');
    expect(out).toContain('Node.js builtin');
    expect(out).toContain('unresolved — dynamic import target is computed');
    // Imports without a local binding are still listed: dynamic + side-effect.
    expect(out).toContain('import()');
    expect(out).toContain('(side-effect import)');
  });

  it('shows the breadcrumb trail and a Back button at depth > 1', () => {
    const out = renderToStaticMarkup(
      <SourceNavigator
        entryFile="nodes.mjs"
        nodeType="DeriveShipmentActuals"
        fetcher={neverFetch}
        initialStack={[{ path: 'nodes.mjs', line: 5 }, { path: 'shipment-logic.mjs', line: 5 }]}
        initialFiles={{ ...files(NODES_MJS), ...files(SHIPMENT_MJS) }}
      />,
    );
    expect(out).toContain('nodes.mjs');
    expect(out).toContain('shipment-logic.mjs');
    expect(out).toContain('›');
    expect(out).toContain('Back');
    // Current file's content is on screen, not the ancestor's.
    expect(text(out)).toContain('return input.actual;');
  });

  it('hides Back at depth 1', () => {
    const out = renderToStaticMarkup(
      <SourceNavigator
        entryFile="nodes.mjs"
        nodeType="DeriveShipmentActuals"
        fetcher={neverFetch}
        initialFiles={files(NODES_MJS)}
      />,
    );
    expect(out).not.toContain('Back');
  });

  it('shows the resolver-unavailable banner while still rendering content', () => {
    const degraded: SourceFilePayload = {
      ...SHIPMENT_MJS,
      resolver: 'unavailable',
      symbols: { declarations: [], imports: [], reexports: [] },
    };
    const out = renderToStaticMarkup(
      <SourceNavigator
        entryFile="shipment-logic.mjs"
        nodeType="DeriveShipmentActuals"
        fetcher={neverFetch}
        initialFiles={files(degraded)}
      />,
    );
    expect(out).toContain('Symbol resolution unavailable (typescript not installed)');
    expect(text(out)).toContain('return input.actual;');
  });

  it('renders the fetch error text (denied / missing / runner down) instead of code', () => {
    const out = renderToStaticMarkup(
      <SourceNavigator
        entryFile=".env"
        nodeType="DeriveShipmentActuals"
        fetcher={neverFetch}
        initialFiles={{ '.env': { ok: false, error: 'Access denied: path not servable' } }}
      />,
    );
    expect(out).toContain('Access denied: path not servable');
    expect(out).not.toContain('Referenced code');
  });
});

describe('NodeCodeView (Inspector code dialog body)', () => {
  it('without sourceRef renders exactly the legacy highlighter view — no Referenced code', () => {
    const out = renderToStaticMarkup(
      <NodeCodeView nodeType="Map" source="async (input) => input" fetcher={neverFetch} />,
    );
    expect(out).toContain('input');
    expect(out).not.toContain('Referenced code');
    expect(out).not.toContain('Built-in node');
    expect(out).not.toContain('source-nav-link');
  });

  it('builtin nodes keep the legacy view plus a quiet Built-in node badge', () => {
    const out = renderToStaticMarkup(
      <NodeCodeView nodeType="Input" source="async () => ({})" builtin fetcher={neverFetch} />,
    );
    expect(out).toContain('Built-in node');
    expect(out).not.toContain('Referenced code');
  });

  it('with a sourceRef renders the SourceNavigator (breadcrumb + loading state pre-fetch)', () => {
    const out = renderToStaticMarkup(
      <NodeCodeView
        nodeType="DeriveShipmentActuals"
        source="ignored"
        sourceRef={{ file: 'nodes.mjs', line: 4 }}
        fetcher={neverFetch}
      />,
    );
    expect(out).toContain('nodes.mjs');
    expect(out).toContain('Loading source…');
  });
});
