import { describe, expect, it } from 'vitest';
import {
  composeAnsweredSubset,
  extractGuidedQuestions,
  resolveGuidedAnswers,
} from './guidedQuestions';
import type { GuidedQuestion } from './guidedQuestions';

const block = (json: string) => '```emberflow-questions\n' + json + '\n```';

describe('extractGuidedQuestions', () => {
  it('happy path: strips a trailing block and normalizes string options', () => {
    const text =
      'Steps 1–4 are done.\n\n' +
      block('{"questions":[{"id":"envs","text":"Which environments?","options":["dev + prod","dev + staging + prod"],"custom":true}]}');
    const { stripped, questions } = extractGuidedQuestions(text);
    expect(stripped).toBe('Steps 1–4 are done.');
    expect(questions).toEqual([
      {
        id: 'envs',
        text: 'Which environments?',
        options: [{ label: 'dev + prod' }, { label: 'dev + staging + prod' }],
        custom: true,
      },
    ]);
  });

  it('tolerates trailing whitespace/newlines after the closing fence', () => {
    const text =
      'Done.\n' + block('{"questions":[{"id":"a","text":"Q?","options":["x"]}]}') + '  \n\n';
    const { stripped, questions } = extractGuidedQuestions(text);
    expect(stripped).toBe('Done.');
    expect(questions).toHaveLength(1);
  });

  it('no block: returns the text unchanged with null questions', () => {
    const text = 'Just prose, with `inline code` and a ```js\nfence\n``` in the middle. The end.';
    expect(extractGuidedQuestions(text)).toEqual({ stripped: text, questions: null });
  });

  it('malformed JSON: leaves the text untouched so nothing is silently lost', () => {
    const text = 'Prose.\n' + block('{"questions": [oops');
    expect(extractGuidedQuestions(text)).toEqual({ stripped: text, questions: null });
  });

  it('invalid shape (questions not an array / bad entries): text untouched, null', () => {
    for (const json of [
      '{"questions":"nope"}',
      '{}',
      '{"questions":[]}',
      '{"questions":[{"id":"a","options":["x"]}]}', // missing text
      '{"questions":[{"id":"a","text":"Q?","options":[42]}]}', // bad option
      '{"questions":[{"id":"a","text":"Q?","options":[]}]}', // unanswerable
    ]) {
      const text = 'Prose.\n' + block(json);
      expect(extractGuidedQuestions(text)).toEqual({ stripped: text, questions: null });
    }
  });

  it('block not at the end: ignored (contract puts it last)', () => {
    const text =
      block('{"questions":[{"id":"a","text":"Q?","options":["x"]}]}') + '\nTrailing prose after.';
    expect(extractGuidedQuestions(text)).toEqual({ stripped: text, questions: null });
  });

  it('mixed string and object options, including a finish action', () => {
    const text = block(
      '{"questions":[{"id":"first-build","text":"What first?","options":["An op",{"label":"Just look around","action":"finish"}],"custom":true}]}',
    );
    const { stripped, questions } = extractGuidedQuestions(text);
    expect(stripped).toBe('');
    expect(questions).toEqual([
      {
        id: 'first-build',
        text: 'What first?',
        options: [{ label: 'An op' }, { label: 'Just look around', action: 'finish' }],
        custom: true,
      },
    ]);
  });

  it('drops unknown option actions rather than forwarding them', () => {
    const { questions } = extractGuidedQuestions(
      block('{"questions":[{"id":"a","text":"Q?","options":[{"label":"x","action":"explode"}]}]}'),
    );
    expect(questions).toEqual([{ id: 'a', text: 'Q?', options: [{ label: 'x' }] }]);
  });

  it('keeps a submit action on an option', () => {
    const { questions } = extractGuidedQuestions(
      block('{"questions":[{"id":"a","text":"Q?","options":[{"label":"Go","action":"submit"}]}]}'),
    );
    expect(questions).toEqual([
      { id: 'a', text: 'Q?', options: [{ label: 'Go', action: 'submit' }] },
    ]);
  });

  it('keeps a non-empty why (trimmed); drops empty/whitespace/non-string ones', () => {
    const { questions } = extractGuidedQuestions(
      block('{"questions":[{"id":"a","text":"Q?","options":["x"],"why":"  So mocks stay safe.  "}]}'),
    );
    expect(questions).toEqual([
      { id: 'a', text: 'Q?', options: [{ label: 'x' }], why: 'So mocks stay safe.' },
    ]);

    for (const why of ['""', '"   "', '42', 'null', '["nope"]']) {
      const { questions: qs } = extractGuidedQuestions(
        block(`{"questions":[{"id":"a","text":"Q?","options":["x"],"why":${why}}]}`),
      );
      expect(qs).toEqual([{ id: 'a', text: 'Q?', options: [{ label: 'x' }] }]);
    }
  });
});

const QUESTIONS: GuidedQuestion[] = [
  { id: 'envs', text: 'Which environments?', options: [{ label: 'dev + prod' }], custom: true },
  {
    id: 'first-build',
    text: 'What do you want to build first?',
    options: [{ label: 'Just look around', action: 'finish' }],
    custom: true,
  },
];

describe('resolveGuidedAnswers', () => {
  it('incomplete until every question has a pill or custom text', () => {
    expect(resolveGuidedAnswers(QUESTIONS, {})).toEqual({ kind: 'incomplete' });
    expect(
      resolveGuidedAnswers(QUESTIONS, { envs: { option: { label: 'dev + prod' } } }),
    ).toEqual({ kind: 'incomplete' });
    // Whitespace-only custom text does not count as an answer.
    expect(
      resolveGuidedAnswers(QUESTIONS, {
        envs: { option: { label: 'dev + prod' } },
        'first-build': { text: '   ' },
      }),
    ).toEqual({ kind: 'incomplete' });
  });

  it('composes one "<question>: <answer>" line per question', () => {
    expect(
      resolveGuidedAnswers(QUESTIONS, {
        envs: { option: { label: 'dev + prod' } },
        'first-build': { text: ' a health-check op ' },
      }),
    ).toEqual({
      kind: 'send',
      text: 'Which environments?: dev + prod\nWhat do you want to build first?: a health-check op',
    });
  });

  it('any picked finish option resolves to finish — nothing is sent', () => {
    expect(
      resolveGuidedAnswers(QUESTIONS, {
        envs: { option: { label: 'dev + prod' } },
        'first-build': { option: { label: 'Just look around', action: 'finish' } },
      }),
    ).toEqual({ kind: 'finish' });
  });

  describe('first-build routing', () => {
    const FIRST_BUILD_ONLY: GuidedQuestion[] = [QUESTIONS[1]];

    it('sole first-build question answered with custom text routes to build', () => {
      expect(
        resolveGuidedAnswers(FIRST_BUILD_ONLY, {
          'first-build': { text: ' an invoicing API ' },
        }),
      ).toEqual({ kind: 'build', text: 'an invoicing API' });
    });

    it('sole first-build question answered with a plain pill still sends', () => {
      const q: GuidedQuestion[] = [
        { id: 'first-build', text: 'What first?', options: [{ label: 'An op' }], custom: true },
      ];
      expect(resolveGuidedAnswers(q, { 'first-build': { option: { label: 'An op' } } })).toEqual({
        kind: 'send',
        text: 'What first?: An op',
      });
    });

    it('first-build custom text alongside OTHER answers keeps the composed send', () => {
      expect(
        resolveGuidedAnswers(QUESTIONS, {
          envs: { option: { label: 'dev + prod' } },
          'first-build': { text: 'an invoicing API' },
        }),
      ).toEqual({
        kind: 'send',
        text: 'Which environments?: dev + prod\nWhat do you want to build first?: an invoicing API',
      });
    });

    it('a sole non-first-build question with custom text still sends', () => {
      expect(
        resolveGuidedAnswers([QUESTIONS[0]], { envs: { text: 'dev only' } }),
      ).toEqual({ kind: 'send', text: 'Which environments?: dev only' });
    });
  });
});

describe('composeAnsweredSubset', () => {
  it('composes only the answered questions, skipping unanswered ones', () => {
    expect(
      composeAnsweredSubset(QUESTIONS, {
        'first-build': { option: { label: 'Skip ahead', action: 'submit' } },
      }),
    ).toBe('What do you want to build first?: Skip ahead');
  });

  it('includes pill and trimmed custom-text answers in question order', () => {
    expect(
      composeAnsweredSubset(QUESTIONS, {
        'first-build': { text: ' a health-check op ' },
        envs: { option: { label: 'dev + prod' } },
      }),
    ).toBe('Which environments?: dev + prod\nWhat do you want to build first?: a health-check op');
  });

  it('whitespace-only custom text is not an answer; nothing answered composes empty', () => {
    expect(composeAnsweredSubset(QUESTIONS, { envs: { text: '   ' } })).toBe('');
    expect(composeAnsweredSubset(QUESTIONS, {})).toBe('');
  });
});

describe('defers option field', () => {
  it('keeps a non-empty defers string on an option, alongside action', () => {
    const text =
      'x\n```emberflow-questions\n{"questions":[{"id":"env","text":"Now?","options":[{"label":"Later","action":"submit","defers":"environments"}]}]}\n```';
    const { questions } = extractGuidedQuestions(text);
    expect(questions?.[0].options[0]).toEqual({
      label: 'Later',
      action: 'submit',
      defers: 'environments',
    });
  });

  it('drops empty/non-string defers', () => {
    const text =
      'x\n```emberflow-questions\n{"questions":[{"id":"env","text":"Now?","options":[{"label":"A","defers":"  "},{"label":"B","defers":7}]}]}\n```';
    const { questions } = extractGuidedQuestions(text);
    expect(questions?.[0].options[0]).toEqual({ label: 'A' });
    expect(questions?.[0].options[1]).toEqual({ label: 'B' });
  });
});
