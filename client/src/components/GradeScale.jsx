import HelpDot from './HelpDot.jsx';
import { HKIS_CHART, CHART_COUNTS, LETTERS, comboLevels, isInferred, uncoveredText } from '../lib/hkisLetterGrade.js';
import { LEVEL_COLORS, LEVEL_LABELS, CELL_TEXT, LETTER_GRADE_COLORS } from '../lib/masteryLevels.js';
import { useProficiencyScale } from '../hooks/useProficiencyScale.js';

// HKIS's letter grade chart (#193), drawn with the level chips: a "?" beside a grade opens this
// course's column (GradeScaleHelp); Settings shows every column and the level score bands
// (GradeScaleChart). Rules: docs/design-language.md, "Grade scale".

const INFERRED_NOTE = 'Not on the HKIS chart; every other 5-category combination with one EM is a C, so Prism uses C.';

function comboText(key) {
  const counts = {};
  for (const l of comboLevels(key)) counts[l] = (counts[l] || 0) + 1;
  return Object.entries(counts).map(([l, c]) => `${c} ${l}`).join(', ');
}

// One combination: a chip per category, best level first.
export function LevelStrip({ combo, n }) {
  const inferred = isInferred(n, combo);
  return (
    <span className="grade-scale__combo" role="img" aria-label={comboText(combo) + (inferred ? ' (not on the HKIS chart)' : '')}>
      <span className="level-strip">
        {comboLevels(combo).map((l, i) => (
          <b key={i} style={{ background: LEVEL_COLORS[l].headerFill, color: CELL_TEXT }}>{l}</b>
        ))}
      </span>
      {inferred && <sup aria-hidden="true">*</sup>}
    </span>
  );
}

function AnyIe() {
  return (
    <span className="grade-scale__combo" role="img" aria-label="any IE">
      <span className="level-strip"><b style={{ background: LEVEL_COLORS.IE.headerFill, color: CELL_TEXT }}>IE</b></span>
      <span className="grade-scale__any">any</span>
    </span>
  );
}

function Combos({ n, letter }) {
  return (
    <span className="grade-scale__combos">
      {letter === 'F' ? <AnyIe /> : HKIS_CHART[n][letter].map((k) => <LevelStrip key={k} combo={k} n={n} />)}
    </span>
  );
}

const Letter = ({ letter, as: Tag = 'span', ...rest }) => (
  <Tag className="grade-scale__letter" style={{ color: LETTER_GRADE_COLORS[letter] }} {...rest}>{letter}</Tag>
);

// The column as words, for the "?"'s aria-label (screen readers and agents).
export function gradeScaleText(n) {
  if (!HKIS_CHART[n]) return uncoveredText(n);
  const rows = LETTERS.map((g) => `${g}: ${g === 'F' ? 'any IE' : HKIS_CHART[n][g].map(comboText).join('; ')}`);
  return `HKIS letter grade, ${n} reporting categories. ${rows.join('. ')}.`;
}

// The "?" beside a grade: this course's column of the chart, in a wide popover.
export function GradeScaleHelp({ numCategories }) {
  const n = numCategories;
  return (
    <HelpDot text={gradeScaleText(n)} wide>
      {HKIS_CHART[n] ? (
        <span className="grade-scale">
          <span className="grade-scale__title">HKIS letter grade, {n} reporting categories</span>
          <span className="grade-scale__rows">
            {LETTERS.map((g) => (
              <span key={g} className="grade-scale__row"><Letter letter={g} /><Combos n={n} letter={g} /></span>
            ))}
          </span>
          {n === 5 && <span className="grade-scale__foot">* {INFERRED_NOTE}</span>}
          <span className="grade-scale__foot">Other category counts and level score bands: Settings, Grade scale.</span>
        </span>
      ) : gradeScaleText(n)}
    </HelpDot>
  );
}

const fmt = (v) => String(Number(v));

// Settings: every column of the chart, then the score band of each level from the proficiency scale
// in config.yaml, for checking Prism against Schoology and HKIS.
export function GradeScaleChart() {
  const { ready, table } = useProficiencyScale();
  return (
    <div className="grade-scale-chart">
      <div className="grade-scale-chart__scroll">
        <table className="grade-scale-table">
          <thead>
            <tr><th scope="col">Grade</th>{CHART_COUNTS.map((n) => <th key={n} scope="col">{n} categories</th>)}</tr>
          </thead>
          <tbody>
            {LETTERS.map((g) => (
              <tr key={g}>
                <Letter letter={g} as="th" scope="row" />
                {CHART_COUNTS.map((n) => <td key={n}><Combos n={n} letter={g} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted">* {INFERRED_NOTE}</p>
      {ready && (
        <div className="grade-scale-chart__scroll">
          <table className="grade-scale-table grade-scale-bands">
            <caption className="text-sm text-muted">Level score bands (a category's mean score out of 100)</caption>
            <thead>
              <tr>
                {table.map((l) => (
                  <th key={l.code} scope="col" style={{ background: LEVEL_COLORS[l.code]?.headerFill, color: CELL_TEXT }}>
                    {l.code} {l.label ?? LEVEL_LABELS[l.code]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {table.map((l, i) => (
                  <td key={l.code}>
                    {fmt(l.gradeScaled)} to {i === 0 ? '100' : (Number(table[i - 1].gradeScaled) - 0.01).toFixed(2)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
