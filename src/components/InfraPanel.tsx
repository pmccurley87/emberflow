import { Loader2Icon, SparklesIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type {
  InfrastructureItem,
  InfrastructureKind,
  InfrastructureResponse,
} from '../store/infraClient';

/**
 * Per-kind chip colour. Muted, drawn from a curated Tailwind palette so kinds
 * are visually distinguishable at a glance without shouting — a colored dot +
 * label on a neutral chip. Unknown kinds fall through to `other`.
 */
const KIND_COLOR: Record<InfrastructureKind, string> = {
  database: 'text-emerald-500',
  'http-api': 'text-sky-500',
  queue: 'text-violet-500',
  cache: 'text-amber-500',
  email: 'text-pink-500',
  llm: 'text-fuchsia-500',
  auth: 'text-rose-500',
  framework: 'text-cyan-500',
  storage: 'text-teal-500',
  other: 'text-muted-foreground',
};

/**
 * Plain-words gloss per kind, ≤1 line each. Surfaced (muted) under the card when
 * `explainKinds` is set — the modal wants to teach what each kind MEANS to the
 * agent; the Dock tab (dense, familiar) leaves it off. One source of truth so
 * both renders share the same vocabulary.
 */
export const KIND_EXPLANATION: Record<InfrastructureKind, string> = {
  database: 'A data store the project reads and writes — operations can query it through registered nodes.',
  'http-api': 'An external service reached over HTTP — operations call it with the named secret.',
  queue: 'A job queue the project enqueues into or consumes.',
  cache: 'A fast key/value store for transient or hot data.',
  email: 'A transactional email provider.',
  llm: 'A language-model API the project calls.',
  auth: 'An identity/auth provider or token flow.',
  framework: "The app's own serving framework — context, not a callable dependency.",
  storage: 'Object or file storage the project reads and writes.',
  other: "Infrastructure that doesn't fit the other kinds.",
};

function KindChip({ kind }: { kind: InfrastructureKind }) {
  return (
    <Badge variant="mono" className="uppercase tracking-wider">
      <span className={cn('size-1.5 rounded-full bg-current', KIND_COLOR[kind] ?? KIND_COLOR.other)} />
      {kind}
    </Badge>
  );
}

function InfraCard({ item, explainKinds = false }: { item: InfrastructureItem; explainKinds?: boolean }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/70 bg-card px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12.5px] font-medium leading-tight">{item.name}</span>
        <KindChip kind={item.kind} />
      </div>

      {explainKinds && (
        <p className="text-[10.5px] leading-snug text-muted-foreground/80">
          {KIND_EXPLANATION[item.kind] ?? KIND_EXPLANATION.other}
        </p>
      )}

      {item.evidence.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {item.evidence.map((e, i) => (
            <li key={i} className="flex items-baseline gap-1.5 font-mono text-[10.5px] text-muted-foreground">
              <span className="text-foreground/70">{e.file}</span>
              {e.note && <span className="truncate">— {e.note}</span>}
            </li>
          ))}
        </ul>
      )}

      {item.suggestedSecretRefs.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {item.suggestedSecretRefs.map((ref) => (
            <Badge key={ref} variant="outline" className="border-border font-mono text-[9.5px] normal-case tracking-normal">
              {ref}
            </Badge>
          ))}
        </div>
      )}

      {item.notes && <p className="text-[11px] leading-snug text-muted-foreground">{item.notes}</p>}
    </div>
  );
}

/** A dimmed placeholder line used by the empty/greenfield states. */
function InfraEmpty({
  title,
  detail,
  onScout,
  scouting,
  canScout,
  canScoutReason,
}: {
  title: string;
  detail: string;
  onScout?: () => void;
  scouting?: boolean;
  canScout?: boolean;
  canScoutReason?: string;
}) {
  return (
    <div className="flex flex-col items-start gap-2.5 px-1 py-3">
      <div className="flex flex-col gap-1">
        <span className="text-[12.5px] font-medium">{title}</span>
        <span className="max-w-md text-[11.5px] leading-snug text-muted-foreground">{detail}</span>
      </div>
      {onScout && (
        <Button
          size="sm"
          onClick={onScout}
          disabled={scouting || canScout === false}
          title={canScout === false ? canScoutReason : undefined}
        >
          {scouting ? <Loader2Icon className="size-3.5 animate-spin" /> : <SparklesIcon className="size-3.5" />}
          {scouting ? 'Scouting…' : 'Scout infrastructure'}
        </Button>
      )}
    </div>
  );
}

/**
 * Presentational render of GET /infrastructure. Renders purely from props so
 * the component test drives it across manifest / empty / greenfield states
 * without a live runner. `data === null` is the not-yet-loaded / unreachable
 * state (shown identically to "not scouted": both invite the scout).
 */
export function InfraPanel({
  data,
  onScout,
  scouting = false,
  canScout = true,
  canScoutReason,
  explainKinds = false,
}: {
  data: InfrastructureResponse | null;
  onScout?: () => void;
  scouting?: boolean;
  canScout?: boolean;
  canScoutReason?: string;
  /** Render the plain-words per-kind gloss under each card (used by the modal). */
  explainKinds?: boolean;
}) {
  if (!data || data.present === false) {
    return (
      <InfraEmpty
        title="Not scouted yet"
        detail="Have the agent scan this project's dependencies, config files and ORM schemas for the databases, APIs and providers it already uses. The result is written to emberflow/infrastructure.json (committed, no secret values)."
        onScout={onScout}
        scouting={scouting}
        canScout={canScout}
        canScoutReason={canScoutReason}
      />
    );
  }

  const { manifest } = data;

  if (manifest.greenfield || manifest.items.length === 0) {
    return (
      <InfraEmpty
        title="Greenfield project"
        detail={
          manifest.summary ??
          'The scout found no existing databases, APIs or providers — this project is a clean slate. New operations introduce infrastructure as they need it.'
        }
        onScout={onScout}
        scouting={scouting}
        canScout={canScout}
        canScoutReason={canScoutReason}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {manifest.summary && (
        <p className="text-[12px] leading-snug text-foreground/80">{manifest.summary}</p>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2.5">
        {manifest.items.map((item) => (
          <InfraCard key={item.id} item={item} explainKinds={explainKinds} />
        ))}
      </div>
    </div>
  );
}
