import type { ReactNode } from 'react';

/**
 * A tiny, dependency-free markdown SUBSET renderer for agent replies.
 *
 * Supports: **bold**, *italic*, `inline code`, fenced ``` code blocks,
 * #/##/### headings (rendered as slightly-bolder text, NOT giant), `-` and
 * `1.` lists (flat only), and blank-line-separated paragraphs. Anything it
 * doesn't recognise — including malformed markers like an unclosed `**` — is
 * passed through as literal text.
 *
 * Deliberately NOT a full markdown engine and NOT `dangerouslySetInnerHTML`:
 * it returns a React element tree, so there is no HTML-injection surface. The
 * classes reuse the AgentConsole panel's existing tokens (small type, muted
 * foreground, the same code-block treatment as the command output <pre>s).
 */

/** Split inline text into React nodes, handling `code`, **bold**, *italic*.
 *  Unmatched/malformed markers stay literal. Nesting is not supported (flat). */
function parseInline(text: string, keyPrefix: string): ReactNode[] {
  // Alternation order matters: code spans first (their content is literal),
  // then bold (**…**) before italic (*…*) so the double-star wins.
  const pattern = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(\*[^*]+?\*)/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="rounded bg-background/60 px-1 py-0.5 font-mono text-[11px] text-foreground/90">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(
        <strong key={key} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>,
      );
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const HEADING = /^(#{1,3})\s+(.*)$/;
const UL_ITEM = /^[-*]\s+(.+)$/;
const OL_ITEM = /^\d+\.\s+(.+)$/;

/** Convert a markdown subset string to a flat list of block React elements. */
export function renderAgentMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let key = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(' ');
    blocks.push(
      <p key={`p-${key++}`} className="text-[12.5px] leading-relaxed text-foreground/90">
        {parseInline(text, `p${key}`)}
      </p>,
    );
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block: everything until the closing fence is literal.
    if (/^```/.test(line.trim())) {
      flushParagraph();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        body.push(lines[i]);
        i++;
      }
      blocks.push(
        <pre
          key={`code-${key++}`}
          className="my-1 overflow-x-auto rounded border border-border/50 bg-background/40 p-2 font-mono text-[11px] leading-relaxed text-foreground/85"
        >
          {body.join('\n')}
        </pre>,
      );
      continue;
    }

    // Blank line → paragraph boundary.
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    // Heading.
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const size = level === 1 ? 'text-[13.5px]' : level === 2 ? 'text-[13px]' : 'text-[12.5px]';
      blocks.push(
        <p key={`h-${key++}`} className={`mt-1 font-semibold text-foreground ${size}`}>
          {parseInline(heading[2], `h${key}`)}
        </p>,
      );
      continue;
    }

    // Lists: gather consecutive items of the same kind into one <ul>/<ol>.
    if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
      flushParagraph();
      const ordered = OL_ITEM.test(line);
      const re = ordered ? OL_ITEM : UL_ITEM;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(re.exec(lines[i])![1]);
        i++;
      }
      i--; // step back; the outer loop will advance.
      const listKey = key++;
      const children = items.map((item, idx) => (
        <li key={idx} className="pl-0.5">
          {parseInline(item, `li${listKey}-${idx}`)}
        </li>
      ));
      blocks.push(
        ordered ? (
          <ol key={`ol-${listKey}`} className="ml-4 list-decimal space-y-0.5 text-[12.5px] leading-relaxed text-foreground/90">
            {children}
          </ol>
        ) : (
          <ul key={`ul-${listKey}`} className="ml-4 list-disc space-y-0.5 text-[12.5px] leading-relaxed text-foreground/90">
            {children}
          </ul>
        ),
      );
      continue;
    }

    // Plain prose line → accumulate into the current paragraph.
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}
