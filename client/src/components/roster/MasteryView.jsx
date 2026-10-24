import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import HelpDot from '../HelpDot.jsx';
import OverridePopup from '../OverridePopup.jsx';
import { LetterGradePopup, LETTER_GRADE_COLORS } from '../MasteryPerformanceSummary.jsx';
import { ClearIcon } from '../AssessmentFilterBar.jsx';
import { Photo } from './RosterCard.jsx';
import { gradeText } from '../PersonSub.jsx';
import { studentFullName } from '../../lib/studentNames.js';
import { LEVEL_COLORS, CELL_TEXT } from '../../lib/masteryLevels.js';
import { useProficiencyScale } from '../../hooks/useProficiencyScale.js';
import { categoryTracks, studentMastery, classMastery, nextSort, sortedBy } from '../../lib/masteryCompare.js';

// Mastery on the Roster tab (#160; spec "Mastery"). Prism's level is the correct one; Schoology's is
// what students and report cards see, so a difference is a signal to override Schoology. Two columns,
// Prism then Schoology: Schoology's chip is faint when it agrees and filled with an amber ring when it
// differs. Tapping it opens OverridePopup (the student page's write path) with Prism's level first.
// Values: lib/masteryCompare.js.
//
// Two layouts: All reporting categories (one card per student, a line per category, then the grades)
// and one reporting category (a short row per student under a sticky header that sorts). The class
// average comes first in both. A set of linked sections (#178) refuses Schoology writes, so there the
// chip is disabled with the reason.
//
// Private: with Private details off only `locked` is rendered (no level or grade in the page, and the
// scale is not read). The OverridePopup lives here, so it goes with the switch.
// Props: on, locked, mastery (getMasteryForCourse), students (enrolled), courseId, linked,
// onMasteryChanged (re-reads mastery after an override).

export const LINKED_REASON = 'Prism does not write to Schoology for linked sections. Make this change in Schoology.';
const HELP = "Schoology's level is the one students and report cards see. Faint means it matches Prism. "
  + "Highlighted means it differs: tap it to set Schoology's override to Prism's level.";

const fill = (level) => (level && LEVEL_COLORS[level] ? { background: LEVEL_COLORS[level].headerFill, color: CELL_TEXT } : undefined);
const label = (t) => `${t.number} - ${t.name}`;
const pctText = (pct) => `${Math.round(pct)}%`;

function TopicChip({ topic, value, scale }) {
  if (!value) return <span className="mastery-topic mastery-topic--none" title={`${topic.code} ${topic.title}: not assessed yet`}>-</span>;
  return (
    <span className="mastery-topic" style={fill(value.level)} title={`${topic.code} ${topic.title}: ${scale.levelLabel(value.level)} (${pctText(value.pct)})`}>
      {value.level}
    </span>
  );
}

function PrismChip({ track, prism, isClass, scale }) {
  const tip = prism.level == null
    ? `${track.number} ${track.name}: no scores yet`
    : `${track.number} ${track.name}: ${isClass ? 'class average' : 'Prism calculates'} ${scale.levelLabel(prism.level)} (${pctText(prism.pct)})`;
  return <span className={`mastery-level${prism.level ? '' : ' mastery-level--none'}`} style={fill(prism.level)} title={tip}>{prism.level ?? '-'}</span>;
}

function SchoologyChip({ track, cell, linked, scale, onOpen }) {
  const s = cell.schoology;
  const p = cell.prism.level;
  const held = s ? `${scale.levelLabel(s.level)}${s.isOverride ? ' (an override)' : ''}` : 'no level';
  let tip;
  if (linked) tip = LINKED_REASON;
  else if (cell.differs) tip = `Schoology holds ${held}, Prism calculates ${scale.levelLabel(p)}. Tap to override Schoology to ${p}.`;
  else tip = `Schoology holds ${held}${p ? ', the same as Prism' : ''}. Tap to override.`;
  return (
    <button type="button" className={`sgc${cell.differs ? ' off' : ''}`} style={cell.differs ? fill(s?.level) : undefined}
      disabled={linked} title={tip} aria-label={`${label(track)}, Schoology. ${tip}`}
      onClick={(e) => { e.stopPropagation(); onOpen(e.currentTarget); }}>
      {s ? `${s.level}${s.isOverride ? '*' : ''}` : '-'}
    </button>
  );
}

function GradeCell({ grade, isClass }) {
  const p = grade.prism;
  const s = grade.schoology;
  const tip = s === p ? "Schoology's levels give the same grade" : `Schoology's levels give ${s ?? 'no grade'}; Prism's give ${p ?? 'no grade'}`;
  return (
    <span className="mastery-grade">
      <span className="mastery-grade__prism" style={p ? { color: LETTER_GRADE_COLORS[p] } : undefined}
        title={isClass ? 'Class average grade' : "Prism's grade, from Prism's category levels"}>
        {p ?? '-'}
      </span>
      {isClass
        ? <span className="mastery-blank" aria-hidden="true" />
        : <span className={`sgc sgc--grade${grade.differs ? ' off' : ''}`} style={grade.differs && s ? { color: LETTER_GRADE_COLORS[s] } : undefined} title={tip}>{s ?? '-'}</span>}
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
  return <span className="mastery-hl mastery-head__sgy"><span>Schoology</span><HelpDot text={HELP} /></span>;
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

function AllCategories({ tracks, rows, classRow, count, linked, scale, onOverride, onScale }) {
  const open = useOpenStudent();
  const maxTopics = Math.max(1, ...tracks.map((t) => t.topics.length));
  const card = (student, m) => (
    <div key={student ? student.id : 'class'} className={`mastery-card${student ? '' : ' mastery-card--class'}`} onClick={open(student)}>
      <Who student={student} count={count} />
      <span className="mastery-card__lines">
        {tracks.map((t) => (
          <span key={t.id} className="mastery-line">
            <span className="mastery-cat" title={label(t)}>{t.number}</span>
            <span className="mastery-topics">
              {t.topics.map((tp) => <TopicChip key={tp.id} topic={tp} value={m.topics[tp.id]} scale={scale} />)}
            </span>
            <span className="mastery-divider" aria-hidden="true" />
            <Pair track={t} cell={m.categories[t.id]} isClass={!student} linked={linked} scale={scale}
              onOverride={(track, cell) => onOverride(student, track, cell)} />
          </span>
        ))}
      </span>
      <span className="mastery-card__grade"><GradeCell grade={m.grade} isClass={!student} /></span>
    </div>
  );
  return (
    <div className="mastery-all" style={{ '--maxt': maxTopics }}>
      <div className="mastery-head">
        <span className="mastery-head__lines">
          <span />
          <span className="mastery-hl mastery-hl--start">Topic averages</span>
          <span />
          <span className="mastery-pair"><span className="mastery-hl">Prism</span><SchoologyHeading /></span>
        </span>
        <span className="mastery-head__grades">
          <span className="mastery-hl mastery-head__grade">
            <span>Grade</span>
            <button type="button" className="filter-btn-link" onClick={onScale}>Scale</button>
          </span>
          <span className="mastery-hl" title="The grade Schoology's levels give">Schoology levels</span>
        </span>
      </div>
      <div className="mastery-phone-help">
        <span><b>Left:</b> Prism</span><span><b>Right:</b> Schoology</span><HelpDot text={HELP} />
        <button type="button" className="filter-btn-link" onClick={onScale}>Scale</button>
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
          <button key={tp.id} type="button" className={th(tp.id)} aria-pressed={sort?.key === tp.id} title={tp.title}
            onClick={() => setSort((cur) => nextSort(cur, tp.id))}>
            <b>{tp.code}{arrow(tp.id)}</b><span className="mastery-th__name">{tp.title}</span>
          </button>
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
  const [showScale, setShowScale] = useState(false);

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
      {linked && <p className="text-sm text-muted">{LINKED_REASON}</p>}
      {one
        ? <OneCategory key={one.id} track={one} rows={rows} classRow={classRow} linked={linked} scale={scale} onOverride={onOverride} />
        : (
          <AllCategories tracks={tracks} rows={rows} classRow={classRow} count={students.length} linked={linked} scale={scale}
            onOverride={onOverride} onScale={() => setShowScale(true)} />
        )}
      {showScale && <LetterGradePopup onClose={() => setShowScale(false)} numCategories={tracks.length} />}
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

export default function MasteryView({ on, locked = null, mastery, students, courseId, linked = false, onMasteryChanged }) {
  if (!on) return locked;
  if (!categoryTracks(mastery).length) return <p className="text-sm text-muted">No mastery data yet. Press Sync Course.</p>;
  return <MasteryOn mastery={mastery} students={students} courseId={courseId} linked={linked} onMasteryChanged={onMasteryChanged} />;
}
