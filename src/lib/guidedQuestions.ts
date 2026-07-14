/**
 * The guided-setup agent ends messages that need the user's input with a fenced
 * ```emberflow-questions block (see server/agents/prompt.ts, 'guided-setup'):
 * JSON describing clickable questions the studio renders as a form instead of
 * a raw code block. This module owns the contract's client side — extraction,
 * defensive parsing/normalization, and turning the user's picks back into the
 * plaintext continuation message the agent expects.
 */

export interface GuidedQuestionOption {
  label: string;
  /** 'finish' ends onboarding client-side instead of sending a run; 'submit'
   *  records the answer and immediately sends whatever has been answered so
   *  far (a subset — unanswered questions are simply skipped). */
  action?: 'finish' | 'submit';
}

export interface GuidedQuestion {
  id: string;
  text: string;
  options: GuidedQuestionOption[];
  /** Also offer a free-text field alongside the clickable options. */
  custom?: boolean;
  /** One-line rationale rendered under the question text. */
  why?: string;
}

/** Trailing fenced block: ```emberflow-questions\n<json>\n``` and then nothing
 *  but whitespace. The prompt contract puts the block LAST; anything after the
 *  closing fence means it's not the interactive form. */
const TRAILING_BLOCK = /```emberflow-questions[ \t]*\n([\s\S]*?)\n?```\s*$/;

function normalizeOption(raw: unknown): GuidedQuestionOption | null {
  if (typeof raw === 'string') return { label: raw };
  if (raw && typeof raw === 'object' && typeof (raw as { label?: unknown }).label === 'string') {
    const { label, action } = raw as { label: string; action?: unknown };
    // Unknown actions are dropped (the option stays clickable, just inert).
    return action === 'finish' || action === 'submit' ? { label, action } : { label };
  }
  return null;
}

function normalizeQuestion(raw: unknown): GuidedQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const { id, text, options, custom, why } = raw as {
    id?: unknown;
    text?: unknown;
    options?: unknown;
    custom?: unknown;
    why?: unknown;
  };
  if (typeof id !== 'string' || typeof text !== 'string' || !Array.isArray(options)) return null;
  const normalized: GuidedQuestionOption[] = [];
  for (const o of options) {
    const opt = normalizeOption(o);
    if (!opt) return null;
    normalized.push(opt);
  }
  // A question with no options and no free-text field is unanswerable.
  if (normalized.length === 0 && custom !== true) return null;
  // `why` must be a non-empty string; anything else is dropped, not fatal.
  const rationale = typeof why === 'string' && why.trim() !== '' ? why.trim() : undefined;
  return {
    id,
    text,
    options: normalized,
    ...(custom === true ? { custom: true } : {}),
    ...(rationale !== undefined ? { why: rationale } : {}),
  };
}

/**
 * Find and strip a trailing `emberflow-questions` fenced block. Malformed JSON
 * or an invalid shape returns the text UNTOUCHED with `questions: null` —
 * nothing is silently lost; the stream just shows the raw block as prose.
 */
export function extractGuidedQuestions(text: string): {
  stripped: string;
  questions: GuidedQuestion[] | null;
} {
  const match = TRAILING_BLOCK.exec(text);
  if (!match) return { stripped: text, questions: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return { stripped: text, questions: null };
  }
  const rawQuestions = (parsed as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return { stripped: text, questions: null };
  }
  const questions: GuidedQuestion[] = [];
  for (const q of rawQuestions) {
    const normalized = normalizeQuestion(q);
    if (!normalized) return { stripped: text, questions: null };
    questions.push(normalized);
  }
  return { stripped: text.slice(0, match.index).replace(/\s+$/, ''), questions };
}

/** One answer per question id: a picked option OR free text (never both). */
export type GuidedAnswers = Record<
  string,
  { option?: GuidedQuestionOption; text?: string } | undefined
>;

/** The agent's closing "what do you want to build first?" question — a custom
 *  answer to it (alone) routes into the real build flow, not a continuation. */
export const FIRST_BUILD_QUESTION_ID = 'first-build';

export type GuidedSubmit =
  | { kind: 'incomplete' }
  /** A selected option carried action 'finish' — end onboarding, send nothing. */
  | { kind: 'finish' }
  /** Composed plaintext continuation: one `<question>: <answer>` line each. */
  | { kind: 'send'; text: string }
  /** The ONLY answer is free text on the 'first-build' question — open the
   *  create-API flow pre-filled with the description instead of sending a run. */
  | { kind: 'build'; text: string };

/**
 * Resolve the form's submit: every question must be answered (pill or custom
 * text); any picked 'finish' option wins over sending. When the form's sole
 * question is 'first-build' and it was answered with custom text (not a pill),
 * the submit routes to the build flow instead of a continuation run. Pure so
 * the component test can exercise the submit path without DOM interactions.
 */
export function resolveGuidedAnswers(
  questions: GuidedQuestion[],
  answers: GuidedAnswers,
): GuidedSubmit {
  const lines: string[] = [];
  let finish = false;
  for (const q of questions) {
    const a = answers[q.id];
    const custom = a?.text?.trim();
    if (a?.option) {
      if (a.option.action === 'finish') finish = true;
      lines.push(`${q.text}: ${a.option.label}`);
    } else if (custom) {
      lines.push(`${q.text}: ${custom}`);
    } else {
      return { kind: 'incomplete' };
    }
  }
  if (finish) return { kind: 'finish' };
  // The only answered question is 'first-build' with a typed description —
  // that's a build request, not an interview answer. Alongside OTHER answers
  // it stays part of the composed continuation.
  const soleBuildText =
    questions.length === 1 && questions[0].id === FIRST_BUILD_QUESTION_ID
      ? answers[questions[0].id]?.text?.trim()
      : undefined;
  if (soleBuildText && !answers[questions[0].id]?.option) {
    return { kind: 'build', text: soleBuildText };
  }
  return { kind: 'send', text: lines.join('\n') };
}

/**
 * Compose ONLY the answered questions into the same `<question>: <answer>`
 * plaintext the full resolver sends — unanswered questions are skipped, not
 * required. Powers a 'submit' option: clicking it records the answer and sends
 * immediately with whatever the user has answered so far. Pure for the same
 * reason as `resolveGuidedAnswers`.
 */
export function composeAnsweredSubset(
  questions: GuidedQuestion[],
  answers: GuidedAnswers,
): string {
  const lines: string[] = [];
  for (const q of questions) {
    const a = answers[q.id];
    const custom = a?.text?.trim();
    if (a?.option) lines.push(`${q.text}: ${a.option.label}`);
    else if (custom) lines.push(`${q.text}: ${custom}`);
  }
  return lines.join('\n');
}
