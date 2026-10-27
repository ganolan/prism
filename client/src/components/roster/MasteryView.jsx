import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import HelpDot, { Tip } from '../HelpDot.jsx';
import OverridePopup from '../OverridePopup.jsx';
import { GradeScaleHelp } from '../GradeScale.jsx';
import { chartCovers, uncoveredText } from '../../lib/hkisLetterGrade.js';
import { ClearIcon } from '../AssessmentFilterBar.jsx';
import { Photo } from './RosterCard.jsx';
import { gradeText } from '../PersonSub.jsx';
import { studentFullName } from '../../lib/studentNames.js';
import { LEVEL_COLORS, CELL_TEXT, LETTER_GRADE_COLORS } from '../../lib/masteryLevels.js';
import { useProficiencyScale } from '../../hooks/useProficiencyScale.js';
import { categoryTracks, studentMastery, classMastery, nextSort, sortedBy, missingCategories } from '../../lib/masteryCompare.js';

// Mastery on the Roster tab (#160; spec "Mastery"). Prism's level is the correct one; Schoology's is
// what students and report cards see, so a difference is a signal to override Schoology. Two columns,
// Prism then Schoology: Schoology's chip is faint when it agrees and filled with an amber ring when it
// differs. Tapping it opens OverridePopup (the student page's write path) with Prism's level first.
// Values: lib/masteryCompare.js.
//
// Two layouts: All reporting categories (one card per student, a line per category, then the grades)
// and one reporting category (a short row per student under a sticky header that sorts). The class
// average comes first in both. A set of linked sections (#178) and an archived course (#188) refuse
// Schoology writes, so there the chip is disabled with the reason (internally `linked` holds that reason).
//
// A category shows as its short label (P, CRC: lib/categoryAbbr.js, #192), never its number. Every hover
// text here is the instant popover (Tip, HelpDot), never a native title; a "-" grade's popover names the
// categories that have no evidence yet.
//
// Private: with Private details off only `locked` is rendered (no level or grade in the page, and the
// scale is not read). The OverridePopup lives here, so it goes with the switch.
// Props: on, locked, mastery (getMasteryForCourse), failed (its last read failed), students (enrolled), courseId, linked,
// archived, onMasteryChanged (re-reads mastery after an override).

export const LINKED_REASON = 'Prism does not write to Schoology for linked sections. Make this change in Schoology.';
export const ARCHIVED_REASON = 'Prism does not write to Schoology for an archived course. Make this change in Schoology.';
const reasonText = (linked) => (typeof linked === 'string' ? linked : LINKED_REASON);
const HELP = "Schoology's level is the one students and report cards see. Faint means it matches Prism. "
  + "Highlighted means it differs: tap it to set Schoology's override to Prism's level.";
// The same help as a short list, for the popover (#192: wrapped, never one long line).
const HELP_POP = (
  <ul className="help-pop__list">
    <li><b>Schoology&apos;s level</b> is the one students and report cards see.</li>
    <li><b>Faint:</b> it matches Prism.</li>
    <li><b>Highlighted:</b> it differs. Tap it to set Schoology&apos;s override to Prism&apos;s level.</li>
  </ul>
);

const fill = (level) => (level && LEVEL_COLORS[level] ? { background: LEVEL_COLORS[level].headerFill, color: CELL_TEXT } : undefined);
const label = (t) => `${t.abbr} - ${t.name}`;
const pctText = (pct) => `${Math.round(pct)}%`;
// "A", "A and B", "A, B and C".
const listNames = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

// Why a grade is "-" (#192, item 9): the categories with no evidence on that side, named.
export function blankGradeText(missing, { isClass = false } = {}) {
  const verb = missing.length === 1 ? 'has' : 'have';
  return `No ${isClass ? 'class grade' : 'grade'} yet: ${listNames(missing)} ${verb} no evidence. A grade needs evidence in every reporting category.`;
}

function TopicChip({ topic, value, scale }) {
  if (!value) return <Tip className="mastery-topic mastery-topic--none" text={`${topic.code} ${topic.title}: not assessed yet`}>-</Tip>;
  return (
    <Tip className="mastery-topic" style={fill(value.level)} text={`${topic.code} ${topic.title}: ${scale.levelLabel(value.level)} (${pctText(value.pct)})`}>
      {value.level}
    </Tip>
  );
}

// The category's short label; its full name on hover or focus.
function CategoryLabel({ track }) {
  return <Tip className="mastery-cat" text={track.name}>{track.abbr}</Tip>;
}

function PrismChip({ track, prism, isClass, scale }) {
  const tip = prism.level == null
    ? `${track.name}: no evidence yet`
    : `${track.name}: ${isClass ? 'class average' : 'Prism calculates'} ${scale.levelLabel(prism.level)} (${pctText(prism.pct)})`;
  return <Tip className={`mastery-level${prism.level ? '' : ' mastery-level--none'}`} style={fill(prism.level)} text={tip}>{prism.level ?? '-'}</Tip>;
}

function SchoologyChip({ track, cell, linked, scale, onOpen }) {
  const s = cell.schoology;
  const p = cell.prism.level;
  const held = s ? `${scale.levelLabel(s.level)}${s.isOverride ? ' (an override)' : ''}` : 'no level';
  let tip;
  if (linked) tip = reasonText(linked);
  else if (cell.differs) tip = `Schoology holds ${held}, Prism calculates ${scale.levelLabel(p)}. Tap to override Schoology to ${p}.`;
  else tip = `Schoology holds ${held}${p ? ', the same as Prism' : ''}. Tap to override.`;
  return (
    <Tip as="button" type="button" className={`sgc${cell.differs ? ' off' : ''}`} style={cell.differs ? fill(s?.level) : undefined}
      disabled={linked} text={tip} aria-label={`${label(track)}, Schoology. ${tip}`}
      onClick={(e) => { e.stopPropagation(); onOpen(e.currentTarget); }}>
      {s ? `${s.level}${s.isOverride ? '*' : ''}` : '-'}
    </Tip>
  );
}

// The translated grade (HKIS's chart on Prism's levels). A "-" grade's popover names the categories it is
// waiting for. When Schoology's levels, the ones students see, translate to another grade (or none), an
// amber "!" says so and how to correct it: override Schoology's level (#193 follow-up, Graham 25 Oct 2026).
export function mismatchText({ prism, schoology }, missing, linked) {
  const fix = linked ? reasonText(linked) : "To correct it, override Schoology's level: click a highlighted Schoology level.";
  const seen = schoology == null
    ? `Schoology holds no level for ${listNames(missing)}, so students see a blank grade.`
    : `Students see Schoology's levels, so their grade translates to ${schoology}, not ${prism}.`;
  return `Schoology's levels differ from Prism's. ${seen} ${fix}`;
}

function GradeCell({ grade, isClass, tracks, categories, linked }) {
  const p = grade.prism;
  const covered = chartCovers(tracks.length);
  const tip = !covered ? uncoveredText(tracks.length)
    : p == null ? blankGradeText(missingCategories(tracks, categories, 'prism'), { isClass })
    : isClass ? `Class average translated grade: ${p}` : `Translated grade from Prism's levels: ${p}`;
  const warn = covered && !isClass && grade.differs;
  return (
    <span className="mastery-grade">
      <Tip className="mastery-grade__prism" style={p ? { color: LETTER_GRADE_COLORS[p] } : undefined} text={tip}>
        {/* The letter alone is centred, so letters line up down the column; a + or - sits to its right. */}
        {p ? <>{p[0]}{p.length > 1 && <span className="mastery-grade__mod">{p.slice(1)}</span>}</> : '-'}
      </Tip>
      {warn && (
        <Tip className="mastery-grade__warn" text={mismatchText(grade, missingCategories(tracks, categories, 'schoology'), linked)}>!</Tip>
      )}
    </span>
  );
}

// The Prism and Schoology pair for one category; the class row keeps an empty Schoology slot.
function Pair({ track, cell, isClass, linked, scale, onOverride }) {
  return (
    <span className="mastery-pair">
      <PrismChip track={track} prism={cell.prism} isClass={isClass} scale={scale} />
      {isClass ? <span className="mastery-blank" aria-hidden="true" />
        : <SchoologyChip track={track} cell={cell} linked={linked} scale={scale} onOpen={() => onOverride(track, cell)} />}
    </span>
  );
}

function SchoologyHeading() {
  return <span className="mastery-hl mastery-head__sgy"><span>Schoology</span><HelpDot text={HELP}>{HELP_POP}</HelpDot></span>;
}

// Who: the photo, the name (a link to the student page) and the grade and number line; or the class.
function Who({ student, count, compact = false }) {
  if (!student) {
    return (
      <>
        <span className="mastery-card__avatar"><span className="roster-card__photo roster-card__photo--initials mastery-class-photo" aria-hidden="true">Class</span></span>
        <span className="mastery-card__id">
          <span className="mastery-card__name">Class average</span>
          {!compact && <span className="roster-card__meta"><span>{count} {count === 1 ? 'student' : 'students'}</span></span>}
        </span>
      </>
    );
  }
  const number = student.email ? student.email.split('@')[0] : null;
  const grade = gradeText(student.grad_year);
  return (
    <>
      <span className="mastery-card__avatar"><Photo student={student} /></span>
      <span className="mastery-card__id">
        <Link className="mastery-card__name" to={`/student/${student.id}`}>{studentFullName(student)}</Link>
        {!compact && (grade || number) && (
          <span className="roster-card__meta">
            {grade && <span>{grade}</span>}
            {number && <span className="roster-card__number">{number}</span>}
          </span>
        )}
      </span>
    </>
  );
}

function useOpenStudent() {
  const navigate = useNavigate();
  return (student) => (e) => {
    if (!student || e.target.closest('a, button')) return;
    navigate(`/student/${student.id}`);
  };
}

function AllCategories({ tracks, rows, classRow, count, linked, scale, onOverride }) {
  const open = useOpenStudent();
  const maxTopics = Math.max(1, ...tracks.map((t) => t.topics.length));
  // The label column fits the longest short label (about 8px a letter at its size).
  const catWidth = Math.max(26, 10 + 8 * Math.max(1, ...tracks.map((t) => t.abbr.length)));
  const card = (student, m) => (
    <div key={student ? student.id : 'class'} className={`mastery-card${student ? '' : ' mastery-card--class'}`} onClick={open(student)}>
      <Who student={student} count={count} />
      <span className="mastery-card__lines">
        {tracks.map((t) => (
          <span key={t.id} className="mastery-line">
            <CategoryLabel track={t} />
            <span className="mastery-topics">
              {t.topics.map((tp) => <TopicChip key={tp.id} topic={tp} value={m.topics[tp.id]} scale={scale} />)}
            </span>
            <span className="mastery-divider" aria-hidden="true" />
            <Pair track={t} cell={m.categories[t.id]} isClass={!student} linked={linked} scale={scale}
              onOverride={(track, cell) => onOverride(student, track, cell)} />
          </span>
        ))}
      </span>
      <span className="mastery-card__grade"><GradeCell grade={m.grade} isClass={!student} tracks={tracks} categories={m.categories} linked={linked} /></span>
    </div>
  );
  return (
    <div className="mastery-all" style={{ '--maxt': maxTopics, '--catw': `${catWidth}px` }}>
      <div className="mastery-head">
        <span className="mastery-head__lines">
          <span />
          <span className="mastery-hl mastery-hl--start">Topic averages</span>
          <span />
          <span className="mastery-pair"><span className="mastery-hl">Prism</span><SchoologyHeading /></span>
        </span>
        <span className="mastery-head__grades">
          <span className="mastery-hl mastery-head__grade">
            <span>Translated grade</span>
            <GradeScaleHelp numCategories={tracks.length} />
          </span>
        </span>
      </div>
      <div className="mastery-phone-help">
        <span><b>Left:</b> Prism</span><span><b>Right:</b> Schoology</span><HelpDot text={HELP}>{HELP_POP}</HelpDot>
        <span className="mastery-phone-help__grade">Translated grade <GradeScaleHelp numCategories={tracks.length} /></span>
      </div>
      {card(null, classRow)}
      {rows.map(({ student, m }) => card(student, m))}
    </div>
  );
}

const SORT_WORDS = { desc: 'highest first', asc: 'lowest first' };

function OneCategory({ track, rows, classRow, linked, scale, onOverride }) {
  const open = useOpenStudent();
  const [sort, setSort] = useState(null); // { key: topic id | 'prism', dir: 'desc' | 'asc' }
  const valueOf = ({ m }) => (sort?.key === 'prism' ? m.categories[track.id].prism.pct : m.topics[sort?.key]?.pct ?? null);
  const shown = sortedBy(rows, sort, valueOf);
  const sortedTopic = track.topics.find((t) => t.id === sort?.key);
  const sortName = sort?.key === 'prism' ? "Prism's level" : sortedTopic ? `${sortedTopic.code} ${sortedTopic.title}` : null;
  const arrow = (key) => (sort?.key === key ? <span className="mastery-th__arrow" aria-hidden="true">{sort.dir === 'desc' ? '▼' : '▲'}</span> : null);
  const th = (key) => `mastery-th${sort?.key === key ? ' mastery-th--sorted' : ''}`;
  const row = (student, m) => (
    <div key={student ? student.id : 'class'} className={`mastery-row${student ? '' : ' mastery-row--class'}`} onClick={open(student)}>
      <span className="mastery-row__who">
        <Who student={student} compact />
      </span>
      {track.topics.map((tp) => <TopicChip key={tp.id} topic={tp} value={m.topics[tp.id]} scale={scale} />)}
      <span className="mastery-divider" aria-hidden="true" />
      <Pair track={track} cell={m.categories[track.id]} isClass={!student} linked={linked} scale={scale}
        onOverride={(t, cell) => onOverride(student, t, cell)} />
    </div>
  );
  return (
    <div className="mastery-one" style={{ '--n': Math.max(1, track.topics.length) }}>
      <div className="mastery-sortbar" aria-live="polite">
        {sort
          ? (
            <>
              <span>Sorted by {sortName}, {SORT_WORDS[sort.dir]}.</span>
              <button type="button" className="filter-btn-clear" onClick={() => setSort(null)}><ClearIcon /> Clear sort</button>
            </>
          )
          : <span>Tap a column heading to sort.</span>}
      </div>
      <div className="mastery-row mastery-row--head">
        <span className="mastery-row__who"><span /><b className="mastery-row__title">{label(track)}</b></span>
        {track.topics.map((tp) => (
          <Tip as="button" key={tp.id} type="button" className={th(tp.id)} aria-pressed={sort?.key === tp.id} text={tp.title}
            aria-label={`${tp.code} ${tp.title}`} onClick={() => setSort((cur) => nextSort(cur, tp.id))}>
            <b>{tp.code}{arrow(tp.id)}</b><span className="mastery-th__name">{tp.title}</span>
          </Tip>
        ))}
        <span />
        <span className="mastery-pair">
          <button type="button" className={th('prism')} aria-pressed={sort?.key === 'prism'} onClick={() => setSort((cur) => nextSort(cur, 'prism'))}>
            <b>Prism{arrow('prism')}</b>
          </button>
          <SchoologyHeading />
        </span>
      </div>
      {row(null, classRow)}
      {shown.map(({ student, m }) => row(student, m))}
    </div>
  );
}

function MasteryOn({ mastery, students, courseId, linked, onMasteryChanged }) {
  const scale = useProficiencyScale();
  const tracks = useMemo(() => categoryTracks(mastery), [mastery]);
  const [cat, setCat] = useState('all'); // 'all' or a category id
  const [target, setTarget] = useState(null); // { student, track, cell }: the override being set
  const [saving, setSaving] = useState(false);

  if (!scale.ready) return <p className="text-sm text-muted">Reading the proficiency scale…</p>;
  const rows = students.map((student) => ({ student, m: studentMastery(mastery, student.schoology_uid, scale) }));
  const classRow = classMastery(mastery, students.map((s) => s.schoology_uid), scale);
  const one = tracks.find((t) => String(t.id) === cat);
  const onOverride = (student, track, cell) => { if (!linked) setTarget({ student, track, cell }); };

  return (
    <div className="mastery">
      <div className="mastery-cats" role="group" aria-label="Reporting categories">
        <button type="button" className={`filter-btn${one ? '' : ' active'}`} aria-pressed={!one} onClick={() => setCat('all')}>
          All reporting categories
        </button>
        {tracks.map((t) => (
          <button key={t.id} type="button" className={`filter-btn${one === t ? ' active' : ''}`} aria-pressed={one === t}
            onClick={() => setCat(String(t.id))}>
            {label(t)}
          </button>
        ))}
      </div>
      {linked && <p className="text-sm text-muted">{reasonText(linked)}</p>}
      {one
        ? <OneCategory key={one.id} track={one} rows={rows} classRow={classRow} linked={linked} scale={scale} onOverride={onOverride} />
        : (
          <AllCategories tracks={tracks} rows={rows} classRow={classRow} count={students.length} linked={linked} scale={scale}
            onOverride={onOverride} />
        )}
      {target && (
        <OverridePopup
          courseId={Number(courseId)}
          studentUid={target.student.schoology_uid}
          objectiveId={target.track.id}
          objectiveTitle={`${studentFullName(target.student)}: ${label(target.track)}`}
          currentLevel={target.cell.schoology?.level ?? null}
          hasOverride={Boolean(target.cell.schoology?.isOverride)}
          suggestedLevel={target.cell.prism.level}
          saving={saving}
          setSaving={setSaving}
          onClose={() => setTarget(null)}
          onSaved={onMasteryChanged}
        />
      )}
    </div>
  );
}

// `failed`: the last mastery read failed (#189). With nothing to show it says so instead of "No mastery
// data yet"; after a failed re-read (an override) the levels already read stay, under a warning.
export default function MasteryView({ on, locked = null, mastery, failed = false, students, courseId, linked = false, archived = false, onMasteryChanged }) {
  const blocked = linked ? LINKED_REASON : archived ? ARCHIVED_REASON : null; // why Schoology writes are refused here
  if (!on) return locked;
  const has = categoryTracks(mastery).length > 0;
  const warning = failed && (
    <div className="alert alert-warning" role="alert">
      {has ? 'Could not read the levels again. These may be out of date: reload the page.' : 'Could not read mastery for this course. Reload the page.'}
    </div>
  );
  if (!has) return warning || <p className="text-sm text-muted">No mastery data yet. Press Sync Course.</p>;
  return (
    <>
      {warning}
      <MasteryOn mastery={mastery} students={students} courseId={courseId} linked={blocked} onMasteryChanged={onMasteryChanged} />
    </>
  );
}
