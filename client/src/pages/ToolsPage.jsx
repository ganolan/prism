import { useState, useEffect, useRef } from 'react';
import { getCourses, getEmails, getRandomStudents, getGroups, getRoster, getToolFilters } from '../services/api.js';
import { studentFullName } from '../lib/studentNames.js';
import { NAME_FORMATS, SEPARATORS, SAMPLE_STUDENT, formatName, formatClassList } from '../lib/nameFormats.js';
import { groupByYearAndSemester } from '../lib/courseDisplay.js';
import { EMAIL_FORMATS, emailText } from '../lib/emailFormats.js';
import { FILTER_TYPES, filterValueLabel, filterValueTitle, rosterFilterQuery, keepHeldValues } from '../lib/rosterFilters.js';
import { usePrivateDetails } from '../lib/privateDetails.js';
import { PrivateHidden } from '../components/PrivateDetails.jsx';
import { Tip } from '../components/HelpDot.jsx';

const GROUP_COLORS = [
  'var(--badge-blue-bg)', 'var(--badge-green-bg)', 'var(--warning-light)',
  'var(--badge-pink-bg)', 'var(--accent-light)', 'var(--secondary-light)',
  'var(--error-light)', 'var(--success-light)',
];

export default function ToolsPage() {
  const [courses, setCourses] = useState([]);
  const [selectedCourses, setSelectedCourses] = useState([]);
  const [showPast, setShowPast] = useState(false);
  const [filters, setFilters] = useState({});
  // #197 (Graham, 25 Oct 2026): the tools are made to be projected, but their filters (gender, grade,
  // overall proficiency) and the Balance percentages are private. With Private details off the filter
  // card is not drawn and no filter applies, so a hidden filter never shapes a projected list.
  const [privateOn] = usePrivateDetails();
  useEffect(() => { if (!privateOn) setFilters({}); }, [privateOn]);
  const filterQuery = privateOn ? rosterFilterQuery(filters) : '';

  useEffect(() => {
    // Current, hidden and past (archived) courses: past ones are listed under their own toggle (#73)
    getCourses(true, true).then(setCourses).catch(console.error);
  }, []);

  function toggleCourse(id) {
    setSelectedCourses(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    );
  }

  // Drop the auto-excluded MASTER/template section and any course with no
  // enrolments, then list real classes first and hidden ones below them.
  const usable = courses.filter(c => !c.excluded && c.student_count > 0);
  const visibleCourses = usable
    .filter(c => !c.archived)
    .sort((a, b) => (a.hidden ? 1 : 0) - (b.hidden ? 1 : 0));
  const pastCourses = usable.filter(c => c.archived);
  const pastYears = groupByYearAndSemester(pastCourses);
  const pastSelected = pastCourses.filter(c => selectedCourses.includes(c.id)).length;

  // Select all covers current courses only: past courses are opt-in, one at a time.
  const allSelected = visibleCourses.length > 0 && visibleCourses.every(c => selectedCourses.includes(c.id));
  const courseLabel = (c) => (
    <label key={c.id} className="text-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', opacity: c.hidden ? 0.6 : 1 }}>
      <input type="checkbox" checked={selectedCourses.includes(c.id)} onChange={() => toggleCourse(c.id)} />
      {c.block_number && <span style={{ color: 'var(--accent)', fontWeight: 700 }}>[BK {c.block_number}]</span>}
      {c.course_name}
      {!!c.hidden && <span className="badge" style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}>Hidden</span>}
    </label>
  );

  return (
    <div className="fade-in">
      <h2 className="page-title">Class Tools</h2>

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', gap: '1rem' }}>
          <label className="text-sm" style={{ fontWeight: 600 }}>Select courses</label>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="ghost" onClick={() => setSelectedCourses(prev => [...new Set([...prev, ...visibleCourses.map(c => c.id)])])} disabled={allSelected}>Select all</button>
            <button className="ghost" onClick={() => setSelectedCourses([])} disabled={selectedCourses.length === 0}>Clear</button>
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1.25rem' }}>
          {visibleCourses.map(courseLabel)}
        </div>
        {pastCourses.length > 0 && (
          <div style={{ marginTop: '0.75rem' }}>
            <button className="ghost" aria-expanded={showPast} onClick={() => setShowPast(v => !v)}>
              {showPast ? '▾' : '▸'} Past courses ({pastCourses.length}){pastSelected > 0 && `, ${pastSelected} selected`}
            </button>
            {showPast && pastYears.map(({ year, semesters }) => (
              <div key={year} data-testid="past-year" style={{ marginTop: '0.5rem' }}>
                <div className="text-sm text-muted" style={{ fontWeight: 600, marginBottom: '0.3rem' }}>{year}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1.25rem' }}>
                  {semesters.flatMap(s => s.courses).map(courseLabel)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedCourses.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {privateOn
            ? <RosterFilters courseIds={selectedCourses} filters={filters} setFilters={setFilters} />
            : <PrivateHidden title="Filters by gender, grade and proficiency are private." />}
          <ClassListTool courseIds={selectedCourses} filters={filterQuery} />
          <EmailTool courseIds={selectedCourses} filters={filterQuery} />
          <RandomPicker courseIds={selectedCourses} filters={filterQuery} />
          <GroupGenerator courseIds={selectedCourses} filters={filterQuery} showPercent={privateOn} />
        </div>
      )}
    </div>
  );
}

// Narrows the combined roster every tool below reads (#73). Closed by default, so the page
// looks as it did until the teacher asks for a filter; a closed bar still states an active filter.
// Values of one type combine with OR, types with AND (server/services/classRoster.js).
function RosterFilters({ courseIds, filters, setFilters }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const query = rosterFilterQuery(filters);
  const active = query !== '';

  // New courses: fetch their choices, and drop chosen values no student there holds.
  useEffect(() => {
    let live = true;
    getToolFilters(courseIds).then((d) => {
      if (!live) return;
      setFilters(prev => keepHeldValues(prev, d.facets));
    }).catch(console.error);
    return () => { live = false; };
  }, [courseIds, setFilters]);

  // The counts follow the chosen filters.
  useEffect(() => {
    let live = true;
    getToolFilters(courseIds, query).then((d) => { if (live) setData(d); }).catch(console.error);
    return () => { live = false; };
  }, [courseIds, query]);

  function toggle(type, value) {
    setFilters(prev => {
      const now = prev[type] ?? [];
      const next = now.includes(value) ? now.filter(v => v !== value) : [...now, value];
      const out = { ...prev };
      if (next.length) out[type] = next; else delete out[type];
      return out;
    });
  }

  const summary = data && (active ? `Showing ${data.matched} of ${data.total} students` : `${data.total} students`);

  return (
    <div className="card" data-testid="roster-filters">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button className="ghost" aria-expanded={open} onClick={() => setOpen(v => !v)}>
          {open ? '▾' : '▸'} Filter students
        </button>
        {summary && <span className={`text-sm${active ? '' : ' text-muted'}`} style={{ fontWeight: active ? 600 : 400 }}>{summary}</span>}
        {active && <button className="ghost" onClick={() => setFilters({})}>Clear filters</button>}
      </div>
      {open && data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.75rem' }}>
          {FILTER_TYPES.map(({ id, label }) => (
            <div key={id} role="group" aria-label={label} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
              <span className="text-sm" style={{ fontWeight: 600, minWidth: '9.5rem' }}>{label}</span>
              {data.facets[id].length === 0 && <span className="text-sm text-muted">None stored</span>}
              {data.facets[id].map(({ value, count }) => {
                const on = (filters[id] ?? []).includes(value);
                // A level code (ED, EX) names itself with its full label, the instant popover too.
                const tip = filterValueTitle(id, value);
                return (
                  <Tip as="button" key={value} className={`filter-btn${on ? ' active' : ''}`} aria-pressed={on}
                    text={tip ? `${tip} (${count})` : undefined} pop={tip} onClick={() => toggle(id, value)}>
                    {filterValueLabel(id, value)} ({count})
                  </Tip>
                );
              })}
            </div>
          ))}
          <span className="text-sm text-muted">Every tool below uses the students these filters keep.</span>
        </div>
      )}
    </div>
  );
}

const SORT_OPTIONS = [
  { id: 'last', label: 'Last name' },
  { id: 'first', label: 'First name' },
];

function ClassListTool({ courseIds, filters }) {
  const [format, setFormat] = useState('first-last');
  const [separator, setSeparator] = useState('newline');
  const [sort, setSort] = useState('last');
  const [roster, setRoster] = useState(null);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef(null);

  const text = roster ? formatClassList(roster, { format, separator, sort }) : '';

  // Changing the course selection or the filters invalidates whatever was generated — clear it
  // rather than leave a list on screen that no longer matches the tick boxes.
  useEffect(() => {
    setRoster(null);
    setCopied(false);
  }, [courseIds, filters]);

  // Grow the textarea to fit the full list so it's all visible without dragging
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  async function handleGenerate() {
    const data = await getRoster(courseIds, filters);
    setRoster(data.students);
    setCopied(false);
  }

  function handleCopy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="card" data-testid="class-list-tool">
      <h3 style={{ marginBottom: '0.75rem' }}>Class List</h3>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <div>
          <label className="text-sm" htmlFor="class-list-format">Format</label>
          <select id="class-list-format" value={format} onChange={e => setFormat(e.target.value)} style={{ width: 'auto' }}>
            {NAME_FORMATS.map(f => (
              <option key={f.id} value={f.id}>{f.label}: {formatName(SAMPLE_STUDENT, f.id)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm" htmlFor="class-list-separator">Separate by</label>
          <select id="class-list-separator" value={separator} onChange={e => setSeparator(e.target.value)} style={{ width: 'auto' }}>
            {SEPARATORS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <label className="text-sm" htmlFor="class-list-sort">Sort by</label>
          <select id="class-list-sort" value={sort} onChange={e => setSort(e.target.value)} style={{ width: 'auto' }}>
            {SORT_OPTIONS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <button className="primary" onClick={handleGenerate}>Generate</button>
        {roster && roster.length > 0 && (
          <button className="primary" onClick={handleCopy} style={{ background: copied ? 'var(--success)' : undefined }}>
            {copied ? 'Copied!' : `Copy ${roster.length} names`}
          </button>
        )}
      </div>
      {roster && roster.length === 0 && (
        <div className="alert alert-warning">No students enrolled in the selected course(s).</div>
      )}
      {roster && roster.length > 0 && (
        <textarea ref={textareaRef} readOnly value={text} rows={3}
          style={{ background: 'var(--bg-subtle)', resize: 'vertical', overflow: 'hidden' }}
        />
      )}
    </div>
  );
}

function EmailTool({ courseIds, filters }) {
  const [type, setType] = useState('student');
  const [format, setFormat] = useState('named');
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef(null);

  const text = emailText(result, format);

  // A list made for other courses or filters no longer matches: clear it.
  useEffect(() => {
    setResult(null);
    setCopied(false);
  }, [courseIds, filters]);

  // Grow the textarea to fit the full list so it's all visible without dragging
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  async function handleGenerate() {
    const data = await getEmails(courseIds, type, filters);
    setResult(data);
    setCopied(false);
  }

  function handleCopy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="card" data-testid="email-tool">
      <h3 style={{ marginBottom: '0.75rem' }}>Email List</h3>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <div>
          <label className="text-sm">Type</label>
          <select value={type} onChange={e => setType(e.target.value)} style={{ width: 'auto' }}>
            <option value="student">Student emails</option>
            <option value="parent">Parent emails</option>
            <option value="both">Both (student + parent)</option>
          </select>
        </div>
        <div>
          <label className="text-sm" htmlFor="email-format">Format</label>
          <select id="email-format" value={format} onChange={e => setFormat(e.target.value)} style={{ width: 'auto' }}>
            {EMAIL_FORMATS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </div>
        <button className="primary" onClick={handleGenerate}>Generate</button>
        {result && (
          <button className="primary" onClick={handleCopy} style={{ background: copied ? 'var(--success)' : undefined }}>
            {copied ? 'Copied!' : `Copy ${result.count} emails`}
          </button>
        )}
        {/* #66: guardians PowerSchool has not cleared for contact are left out by the server. */}
        {result?.excluded > 0 && (
          <span className="text-sm text-muted" style={{ alignSelf: 'center' }}>
            {result.excluded === 1 ? '1 guardian not copied' : `${result.excluded} guardians not copied`}
          </span>
        )}
      </div>
      {result && (
        <textarea ref={textareaRef} readOnly value={text} rows={3}
          style={{ background: 'var(--bg-subtle)', resize: 'vertical', overflow: 'hidden' }}
        />
      )}
    </div>
  );
}

function RandomPicker({ courseIds, filters }) {
  const [count, setCount] = useState(1);
  const [picked, setPicked] = useState([]);
  const [animating, setAnimating] = useState(false);
  const [display, setDisplay] = useState(null);
  const intervalRef = useRef(null);

  const displayName = (s) => studentFullName(s);

  useEffect(() => { setPicked([]); }, [courseIds, filters]);

  async function handlePick() {
    setAnimating(true);
    setPicked([]);
    setDisplay(null);

    const data = await getRandomStudents(courseIds, count, filters);
    const finalPicked = data.picked;

    let tick = 0;
    intervalRef.current = setInterval(() => {
      const idx = Math.floor(Math.random() * data.total);
      setDisplay(`${finalPicked[tick % finalPicked.length]?.first_name || '?'} ...`);
      tick++;
    }, 80);

    setTimeout(() => {
      clearInterval(intervalRef.current);
      setPicked(finalPicked);
      setDisplay(null);
      setAnimating(false);
    }, 1500);
  }

  return (
    <div className="card">
      <h3 style={{ marginBottom: '0.75rem' }}>Random Name Picker</h3>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.75rem' }}>
        <div style={{ width: '80px' }}>
          <label className="text-sm">Count</label>
          <input type="number" min={1} max={30} value={count} onChange={e => setCount(parseInt(e.target.value) || 1)} />
        </div>
        <button className="primary" onClick={handlePick} disabled={animating}>
          {animating ? 'Picking...' : 'Pick'}
        </button>
      </div>
      {animating && display && (
        <div style={{ fontSize: '1.5rem', fontWeight: 700, padding: '1rem', textAlign: 'center', background: 'var(--gradient-primary)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          {display}
        </div>
      )}
      {picked.length > 0 && !animating && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', padding: '0.5rem 0' }}>
          {picked.map(s => (
            <span key={s.id} className="badge badge-blue" style={{ fontSize: '1rem', padding: '0.4rem 0.75rem' }}>
              {displayName(s)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// showPercent: each student's proficiency percentage beside the name in a balanced group (Private details).
function GroupGenerator({ courseIds, filters, showPercent = false }) {
  const [groupCount, setGroupCount] = useState(4);
  const [balanced, setBalanced] = useState(false);
  const [groups, setGroups] = useState(null);

  const displayName = (s) => studentFullName(s);

  useEffect(() => { setGroups(null); }, [courseIds, filters]);

  async function handleGenerate() {
    const data = await getGroups(courseIds, groupCount, balanced, filters);
    setGroups(data.groups);
  }

  function handleExportCSV() {
    if (!groups) return;
    let csv = 'Group,Name\n';
    groups.forEach((g, i) => {
      g.forEach(s => { csv += `${i + 1},"${displayName(s)}"\n`; });
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'groups.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="card">
      <h3 style={{ marginBottom: '0.75rem' }}>Group Generator</h3>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.75rem' }}>
        <div style={{ width: '120px' }}>
          <label className="text-sm">Number of groups</label>
          <input type="number" min={2} max={20} value={groupCount} onChange={e => setGroupCount(parseInt(e.target.value) || 4)} />
        </div>
        <label className="text-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer' }}>
          <input type="checkbox" checked={balanced} onChange={e => setBalanced(e.target.checked)} />
          Balance by overall proficiency
        </label>
        <button className="primary" onClick={handleGenerate}>Generate</button>
        {groups && <button className="secondary" onClick={handleExportCSV}>Export CSV</button>}
      </div>

      {groups && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.75rem' }}>
          {groups.map((g, i) => (
            <div key={i} style={{ background: GROUP_COLORS[i % GROUP_COLORS.length], borderRadius: 10, padding: '0.75rem' }}>
              <strong className="text-sm">Group {i + 1}</strong>
              <ul style={{ listStyle: 'none', marginTop: '0.4rem' }}>
                {g.map(s => (
                  <li key={s.id} className="text-sm" style={{ padding: '0.15rem 0' }}>
                    {displayName(s)}
                    {showPercent && balanced && s.avg_pct != null && <span className="text-muted" style={{ fontSize: '0.75rem', marginLeft: '0.3rem' }}>({s.avg_pct}%)</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
