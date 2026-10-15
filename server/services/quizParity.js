// Parity between copies of a test (spec §3). Copies get new question ids, so a
// question is matched by its fingerprint (kind, normalized stem, points) and,
// when one test repeats a stem, by the order those repeats appear in. Order of
// questions is otherwise ignored: a test can randomize it.
import { questionFingerprint, normalizeStem, plainText } from '../lib/quizText.js';
import { QuizError } from './quizError.js';

const short = (html) => plainText(html).slice(0, 80);

function keyed(questions) {
  const seen = new Map();
  return questions.map(q => {
    const fp = questionFingerprint(q);
    const n = (seen.get(fp) || 0) + 1;
    seen.set(fp, n);
    return { key: `${fp}#${n}`, q };
  });
}

export function compareQuestionLists(lists) {
  const [ref, ...rest] = lists;
  const refKeys = keyed(ref.questions);
  const differences = [];
  for (const other of rest) {
    const otherKeys = keyed(other.questions);
    const otherSet = new Set(otherKeys.map(k => k.key));
    const refSet = new Set(refKeys.map(k => k.key));
    const missing = refKeys.filter(k => !otherSet.has(k.key)).map(k => short(k.q.stemHtml));
    const extra = otherKeys.filter(k => !refSet.has(k.key)).map(k => short(k.q.stemHtml));
    if (missing.length || extra.length) differences.push({ assignmentId: other.assignmentId, title: other.title, missing, extra });
  }
  return { ok: differences.length === 0, differences };
}

export function matchCopies(reference, other) {
  const byKey = new Map(keyed(reference).map(k => [k.key, k.q.qid]));
  const out = new Map();
  for (const { key, q } of keyed(other)) {
    const refQid = byKey.get(key);
    if (!refQid) throw new QuizError('PARITY', `Question not in the first test: ${short(q.stemHtml)}`);
    out.set(q.qid, refQid);
  }
  if (out.size !== reference.length) throw new QuizError('PARITY', 'The tests have a different number of questions');
  return out;
}

// Copies and attempts may show a question's options in another order, so options and the
// key are compared by their text as sets; letters are display positions only.
export function compareLoadedQuestion(a, b) {
  if (a.options && b.options) {
    const texts = (o) => o.map(x => normalizeStem(x.html)).sort().join('|');
    if (texts(a.options) !== texts(b.options)) return 'different answer options';
    const keyTexts = (o) => o.filter(x => x.isKey).map(x => normalizeStem(x.html)).sort().join('|');
    if (keyTexts(a.options) !== keyTexts(b.options)) return 'a different key';
  }
  if (a.rubricId && b.rubricId && a.rubricId !== b.rubricId) return 'a different rubric';
  return null;
}

// The stored letter for the option shown under `letter` on a loaded attempt, matched by text.
export function storedLetterFor(storedOptions, loadedOptions, letter) {
  if (letter == null) return null;
  const chosen = loadedOptions.find(o => o.letter === letter);
  if (!chosen) return null;
  const text = normalizeStem(chosen.html);
  return storedOptions.find(o => normalizeStem(o.html) === text)?.letter ?? null;
}
