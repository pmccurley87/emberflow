import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Fragment, type ReactNode } from 'react';
import { renderAgentMarkdown } from './agentMarkdown';

/** Render the block array to static HTML so we can assert on structure/text. */
function html(source: string): string {
  return renderToStaticMarkup(<Fragment>{renderAgentMarkdown(source) as ReactNode}</Fragment>);
}

describe('renderAgentMarkdown', () => {
  it('renders bold and inline code together inline', () => {
    const out = html('This is **bold** and `code` here.');
    expect(out).toContain('<strong');
    expect(out).toContain('>bold</strong>');
    expect(out).toContain('<code');
    expect(out).toContain('>code</code>');
    // Single paragraph containing both.
    expect((out.match(/<p/g) ?? []).length).toBe(1);
  });

  it('renders italic', () => {
    const out = html('an *emphasised* word');
    expect(out).toContain('<em');
    expect(out).toContain('>emphasised</em>');
  });

  it('renders a fenced code block as a <pre> preserving content literally', () => {
    const out = html('before\n\n```\nconst x = **not bold**;\nline2\n```\n\nafter');
    expect(out).toContain('<pre');
    // Markers inside the fence stay literal — no <strong> emitted for them.
    expect(out).toContain('const x = **not bold**;');
    expect(out).toContain('line2');
    // Prose around it still becomes paragraphs.
    expect(out).toContain('>before</p>');
    expect(out).toContain('>after</p>');
  });

  it('renders headings as slightly-bolder paragraphs, not giant tags', () => {
    const out = html('# Title\n## Sub\n### Small');
    expect(out).not.toContain('<h1');
    expect(out).not.toContain('<h2');
    expect(out).toContain('font-semibold');
    expect(out).toContain('>Title</p>');
    expect(out).toContain('>Sub</p>');
    expect(out).toContain('>Small</p>');
  });

  it('renders unordered lists (flat)', () => {
    const out = html('- one\n- two\n- three');
    expect((out.match(/<ul/g) ?? []).length).toBe(1);
    expect((out.match(/<li/g) ?? []).length).toBe(3);
    expect(out).toContain('>one</li>');
  });

  it('renders ordered lists', () => {
    const out = html('1. first\n2. second');
    expect(out).toContain('<ol');
    expect((out.match(/<li/g) ?? []).length).toBe(2);
    expect(out).toContain('>first</li>');
  });

  it('splits paragraphs on blank lines', () => {
    const out = html('para one\n\npara two');
    expect((out.match(/<p/g) ?? []).length).toBe(2);
  });

  it('passes plain text through unchanged', () => {
    const out = html('just some plain prose with no markup');
    expect(out).toContain('just some plain prose with no markup');
    expect(out).not.toContain('<strong');
    expect(out).not.toContain('<em');
    expect(out).not.toContain('<code');
  });

  it('leaves malformed markdown as literal text', () => {
    // Unclosed bold and a single unpaired star have no valid closing marker, so
    // they fall back to literal text rather than emitting <strong>/<em>.
    const out = html('an **unclosed bold marker\n\n5 * 3 = 15');
    expect(out).not.toContain('<strong');
    expect(out).not.toContain('<em');
    expect(out).toContain('**unclosed bold marker');
    expect(out).toContain('5 * 3 = 15');
  });

  it('does not treat backtick content as bold', () => {
    const out = html('`**literal**`');
    expect(out).toContain('>**literal**</code>');
    expect(out).not.toContain('<strong');
  });
});
