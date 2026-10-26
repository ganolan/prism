// One student's answer to one MCQ on the Attempts tab (#200): the stem, each option with the student's
// choice and the key marked, the points, and the class's percent correct in the Questions tab's bands.
// The aria-label states the whole row in words. `compact` (By question, where the stem and options are
// shown once above) draws only the student's name, choice and result.
import { sanitizeStemHtml } from '../../lib/sanitizeHtml.js';
import { stripOptionLetter } from '../../lib/quizOptions.js';

export function mcqLabel(question, response) {
  const pct = question.facility == null ? null : Math.round(question.facility * 100);
  const chose = response.chosen_letter
    ? `chose ${response.chosen_letter}, ${response.is_correct ? 'correct' : 'incorrect'}`
    : 'no answer';
  const key = !response.is_correct && response.key_letter ? ` Answer ${response.key_letter}.` : '';
  const cls = pct == null ? '' : ` Class ${pct}% correct.`;
  return `Q${question.position}: ${chose}.${key}${cls}`;
}

export default function McqAnswer({ question, response, compact = false, name = null }) {
  if (!response) return null;
  const pct = question.facility == null ? null : Math.round(question.facility * 100);
  const state = response.chosen_letter == null ? 'blank' : response.is_correct ? 'correct' : 'incorrect';
  return (
    <div className={`mcq-answer mcq-answer--${state}${compact ? ' mcq-answer--compact' : ''}`} role="group"
      aria-label={name ? `${name}, ${mcqLabel(question, response)}` : mcqLabel(question, response)}>
      <div className="mcq-answer__head">
        <strong>{name ?? `Q${question.position}`}</strong>
        <span className={`badge ${state === 'correct' ? 'badge-green' : 'badge-red'}`}>
          {state === 'blank' ? 'No answer' : state === 'correct' ? 'Correct' : 'Incorrect'}
        </span>
        {compact && response.chosen_letter && <span className="text-sm">{`Chose ${response.chosen_letter}`}</span>}
        <span className="text-sm text-muted">{`${response.points ?? 0}/${response.max_points ?? question.max_points}`}</span>
        {!compact && pct != null && <span className="text-sm text-muted mcq-answer__class">{`Class ${pct}%`} <span className="badge">{question.band}</span></span>}
      </div>
      {!compact && <div className="mcq-answer__stem" dangerouslySetInnerHTML={{ __html: sanitizeStemHtml(question.stem_html) }} />}
      {!compact && <ul className="mcq-answer__options">
        {(question.options || []).map((o) => {
          const chosen = o.letter === response.chosen_letter;
          const cls = [chosen ? 'is-chosen' : '', o.is_key ? 'is-key' : ''].filter(Boolean).join(' ');
          return (
            <li key={o.letter} className={cls}>
              <span className="mcq-answer__letter">{o.letter}</span>
              <span dangerouslySetInnerHTML={{ __html: sanitizeStemHtml(stripOptionLetter(o.html, o.letter)) }} />
              {chosen && <span className="mcq-answer__mark">{o.is_key ? 'Chosen, correct' : 'Chosen'}</span>}
              {!chosen && o.is_key && <span className="mcq-answer__mark">Answer</span>}
            </li>
          );
        })}
      </ul>}
    </div>
  );
}
