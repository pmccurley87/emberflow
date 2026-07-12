import { useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Json } from './Json';

/**
 * Fullscreen JSON viewer for a single value — display-node previews and dock
 * I/O panes are deliberately small; this is where "too small to read" goes
 * to get a real look, with a one-click copy of the pretty-printed text.
 */
export function JsonModal({
  title,
  value,
  open,
  onOpenChange,
}: {
  title: string;
  value: unknown;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(value, null, 2) ?? 'undefined');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[80vw] h-[85vh]">
        <div className="flex items-center justify-between gap-2 pr-8">
          <DialogTitle className="truncate">{title}</DialogTitle>
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={handleCopy}
          >
            {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <Json value={value} variant="modal" className="h-full" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
