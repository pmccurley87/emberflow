import { memo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { cn } from '@/lib/utils';

/**
 * Shared read-only JSON display: pretty-printed and syntax-highlighted with
 * the same Prism theme as the node-source code modal. Editors (scenario
 * payloads, JSON config fields) stay plain textareas — this is display only.
 */
export const Json = memo(function Json({
  value,
  className,
  maxHeight,
  variant = 'panel',
}: {
  value: unknown;
  className?: string;
  maxHeight?: number;
  /**
   * 'panel' draws its own bordered card sized for compact dock/inspector use;
   * 'preview' is bare — the canvas node's preview class provides the chrome;
   * 'modal' is the same bordered card as 'panel' but scaled up for a
   * fullscreen read (JsonModal), matching the node-source code modal's type scale.
   */
  variant?: 'panel' | 'preview' | 'modal';
}) {
  const text = JSON.stringify(value, null, 2) ?? 'undefined';
  return (
    <div
      className={cn(variant !== 'preview' && 'overflow-auto rounded-md border border-border bg-card', className)}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <SyntaxHighlighter
        language="json"
        style={oneDark}
        customStyle={{
          margin: 0,
          padding: variant === 'preview' ? 0 : variant === 'modal' ? '14px' : '10px',
          background: 'transparent',
          fontSize: variant === 'modal' ? '13px' : variant === 'panel' ? '11.5px' : '10.5px',
          lineHeight: variant === 'modal' ? 1.65 : variant === 'panel' ? 1.6 : 1.55,
        }}
        codeTagProps={{ style: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' } }}
      >
        {text}
      </SyntaxHighlighter>
    </div>
  );
});
