/* ============================================================================
   PRISM · Sunset — workflow pages: Feedback Review, Class Tools, Import, Search
   ============================================================================ */

/* ── Feedback Review ──────────────────────────────────────────────────────── */
const FEEDBACK_SEED = [
  { id: 'f1', sid: 'S1003', assignment: 'Energy Unit Test', topic: '1.4 Cellular Respiration', level: 'EM',
    draft: 'You can describe glycolysis clearly, but the electron transport chain steps are out of order. Revisit how the proton gradient drives ATP synthase — try re-drawing the mitochondrion with the four complexes labeled.' },
  { id: 'f2', sid: 'S1009', assignment: 'DNA Modeling Project', topic: '2.1 DNA Structure', level: 'EX',
    draft: 'Strong antiparallel strand model with correct base pairing. To reach Exhibiting Depth, connect the structure to function: why does the sugar-phosphate backbone sit on the outside?' },
  { id: 'f3', sid: 'S1015', assignment: 'Protein Synthesis Check', topic: '2.3 Protein Synthesis', level: 'IE',
    draft: 'It looks like transcription and translation are being combined into one step. Let’s meet — start by separating where each happens (nucleus vs. ribosome) before the next attempt.' },
  { id: 'f4', sid: 'S1021', assignment: 'Natural Selection Sim', topic: '3.1 Natural Selection', level: 'EX',
    draft: 'Great use of the simulation data to support your claim about allele frequency. Your reasoning links variation to differential survival well. Cite the generation-12 graph explicitly.' },
  { id: 'f5', sid: 'S1006', assignment: 'Ecology Field Study', topic: 'SP.3 Argumentation w/ Evidence', level: 'D',
    draft: 'Your claim about the pond food web is reasonable, but the evidence is mostly observational. Add one quantitative measure (e.g. dissolved O2) and explain how it backs your reasoning.' },
  { id: 'f6', sid: 'S1012', assignment: 'Genetics Unit Test', topic: '2.4 Mendelian Inheritance', level: 'EX',
    draft: 'Punnett squares for the dihybrid cross are correct and the 9:3:3:1 ratio is well explained. Nice work labeling gametes — watch the heterozygous notation in Q4.' },
];

function FeedbackPage() {
  const D = window.PRISM;
  const [items, setItems] = useState(FEEDBACK_SEED.map(f => ({ ...f, status: 'review' })));
  const [filter, setFilter] = useState('review');
  const stu = id => D.students.find(s => s.id === id) || { name: id, initials: '?', color: 'var(--violet)' };

  const visible = items.filter(i => filter === 'all' || i.status === filter);
  const pending = items.filter(i => i.status === 'review').length;

  const set = (id, status) => setItems(items.map(i => i.id === id ? { ...i, status } : i));
  const approveAll = () => setItems(items.map(i => i.status === 'review' ? { ...i, status: 'approved' } : i));

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <div className="eyebrow">AI-drafted · pending teacher review</div>
          <h1 className="page-title">Feedback Review</h1>
          <p className="page-sub">{pending} drafts awaiting your approval before they’re released to students.</p>
        </div>
        <button className="btn primary" onClick={approveAll} disabled={!pending}><Icon name="chat" /> Approve all ({pending})</button>
      </div>

      <div className="seg" style={{ marginBottom: 16 }}>
        {[['review', 'Needs review'], ['approved', 'Approved'], ['revision', 'Revision requested'], ['all', 'All']].map(([k, l]) => (
          <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>

      <div className="fb-list">
        {visible.length === 0 && <div className="card card-pad" style={{ color: 'var(--text-muted)' }}>Nothing here — inbox zero. 🌅</div>}
        {visible.map(f => {
          const s = stu(f.sid);
          return (
            <div className="card fb-item" key={f.id}>
              <div className="fb-side">
                <Avatar s={s} size={34} />
                <div className="fb-info">
                  <div className="fb-name">{s.name}</div>
                  <div className="fb-meta">{f.assignment}</div>
                  <div className="fb-topic"><span className="mono">{f.topic}</span></div>
                </div>
                <span className={'mchip ' + D.LEVEL_META[f.level].cls} style={{ marginLeft: 'auto' }}>{f.level}</span>
              </div>
              <p className="fb-draft">{f.draft}</p>
              <div className="fb-actions">
                {f.status === 'review' ? (
                  <>
                    <button className="btn primary" onClick={() => set(f.id, 'approved')}>Approve &amp; release</button>
                    <button className="btn" onClick={() => set(f.id, 'revision')}>Request revision</button>
                    <button className="btn ghost">Edit draft</button>
                  </>
                ) : (
                  <span className={'fb-status ' + f.status}>
                    {f.status === 'approved' ? '✓ Released to student' : '↻ Sent back for revision'}
                    <button className="btn ghost" onClick={() => set(f.id, 'review')}>Undo</button>
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Class Tools ──────────────────────────────────────────────────────────── */
function ToolsPage() {
  const D = window.PRISM;
  const [picked, setPicked] = useState(null);
  const [spinning, setSpinning] = useState(false);
  const [groupCount, setGroupCount] = useState(5);
  const [balanced, setBalanced] = useState(true);
  const [groups, setGroups] = useState(null);
  const [copied, setCopied] = useState(false);

  const spin = () => {
    setSpinning(true);
    let ticks = 0;
    const iv = setInterval(() => {
      setPicked(D.students[Math.floor(Math.random() * D.students.length)]);
      if (++ticks > 14) { clearInterval(iv); setSpinning(false); }
    }, 70);
  };
  const makeGroups = () => {
    let pool = D.students.map(s => ({ s, st: D.studentStats(s.id) }));
    if (balanced) pool.sort((a, b) => b.st.avg - a.st.avg);
    else pool = pool.map(x => x).sort(() => Math.random() - 0.5);
    const g = Array.from({ length: groupCount }, () => []);
    pool.forEach((p, i) => g[balanced ? i % groupCount : Math.floor(i / Math.ceil(pool.length / groupCount))].push(p.s));
    setGroups(g);
  };
  const copyEmails = () => {
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <div className="eyebrow">{D.course.name} · {D.course.section}</div>
          <h1 className="page-title">Class Tools</h1>
          <p className="page-sub">Quick utilities for running the room.</p>
        </div>
      </div>

      <div className="grid-3 gap">
        <div className="card card-pad tool">
          <h3>Cold-call picker</h3>
          <p className="tool-sub">Pull a random student.</p>
          <div className={'picker' + (spinning ? ' spin' : '')}>
            {picked ? <><Avatar s={picked} size={44} /><span className="picker-name">{picked.name}</span></>
                    : <span className="picker-empty">— ready —</span>}
          </div>
          <button className="btn primary" onClick={spin} disabled={spinning}><Icon name="dots" /> {spinning ? 'Picking…' : 'Pick a student'}</button>
        </div>

        <div className="card card-pad tool">
          <h3>Group maker</h3>
          <p className="tool-sub">Split the class into teams.</p>
          <div className="tool-row">
            <label>Groups</label>
            <div className="seg sm">{[3, 4, 5, 6].map(n => <button key={n} className={groupCount === n ? 'on' : ''} onClick={() => setGroupCount(n)}>{n}</button>)}</div>
          </div>
          <label className="tool-check"><input type="checkbox" checked={balanced} onChange={e => setBalanced(e.target.checked)} /> Balance by mastery</label>
          <button className="btn primary" onClick={makeGroups}><Icon name="users" /> Generate</button>
          {groups && (
            <div className="groups">
              {groups.map((g, i) => (
                <div className="group" key={i}>
                  <div className="group-h">Group {i + 1}</div>
                  {g.map(s => <div className="group-m" key={s.id}><Avatar s={s} size={18} /> {s.name}</div>)}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card card-pad tool">
          <h3>Email list</h3>
          <p className="tool-sub">All student addresses, ready to paste.</p>
          <div className="email-box mono">
            {D.students.slice(0, 6).map(s => s.name.toLowerCase().replace(/[^a-z]/g, '.') + '@school.edu').join(', ')}…
          </div>
          <button className="btn primary" onClick={copyEmails}><Icon name="download" /> {copied ? 'Copied ✓' : `Copy ${D.students.length} addresses`}</button>
        </div>
      </div>
    </div>
  );
}

/* ── Import ───────────────────────────────────────────────────────────────── */
function ImportPage() {
  const D = window.PRISM;
  const rows = [
    ['1001', 'Amara Okafor', '1.4 Cellular Respiration', 'EM', '✓ matched'],
    ['1003', 'Sofia Reyes', '2.3 Protein Synthesis', 'D', '✓ matched'],
    ['1099', 'Unknown Student', '2.3 Protein Synthesis', 'EX', '⚠ no match'],
    ['1009', 'Ava Delgado', '3.2 Phylogenetics', '??', '⚠ bad level'],
  ];
  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <div className="eyebrow">PowerSchool / Schoology CSV</div>
          <h1 className="page-title">Import scores</h1>
          <p className="page-sub">Drop a gradebook export — Prism maps columns to standards and flags anything that won’t line up.</p>
        </div>
      </div>
      <div className="dropzone">
        <Icon name="upload" style={{ width: 30, height: 30, color: 'var(--accent)' }} />
        <div className="dz-title">Drop your CSV here</div>
        <div className="dz-sub">or <button className="btn ghost" style={{ color: 'var(--accent)' }}>browse files</button> · max 10MB</div>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><h3>Preview · mastery_export_fall25.csv</h3><span className="sub">4 of 412 rows · 2 need attention</span><span className="spacer" /><button className="btn primary" disabled>Import 410 rows</button></div>
        <div className="rt-scroll">
          <table className="rt">
            <thead><tr><th>Student ID</th><th>Name</th><th>Standard</th><th>Level</th><th>Mapping</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{r[0]}</td><td>{r[1]}</td><td className="mono">{r[2]}</td>
                  <td>{r[3] === '??' ? <span className="mono" style={{ color: 'var(--accent)' }}>{r[3]}</span> : <span className={'mchip ' + D.LEVEL_META[r[3]].cls}>{r[3]}</span>}</td>
                  <td><span className="status" style={{ color: r[4].includes('⚠') ? 'var(--accent)' : 'var(--good)' }}>{r[4]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ── Search ───────────────────────────────────────────────────────────────── */
function SearchPage({ openStudent }) {
  const D = window.PRISM;
  const [q, setQ] = useState('');
  const results = q ? D.students.filter(s => s.name.toLowerCase().includes(q.toLowerCase())) : D.students.slice(0, 8);
  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <div className="eyebrow">All sections</div>
          <h1 className="page-title">Search students</h1>
          <p className="page-sub">Jump to any student’s mastery profile.</p>
        </div>
      </div>
      <div className="search big">
        <Icon name="search" style={{ width: 18, height: 18 }} />
        <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Type a name…" />
      </div>
      <div className="search-grid">
        {results.map(s => {
          const st = D.studentStats(s.id);
          return (
            <div className="card card-pad sr-card" key={s.id} onClick={() => openStudent && openStudent(s.id)}>
              <Avatar s={s} size={40} />
              <div className="sr-body">
                <div className="sr-name">{s.name}</div>
                <div className="sr-meta mono">{s.id} · {D.course.name}</div>
              </div>
              <div className="sr-right">
                <span className={'mchip ' + D.LEVEL_META[st.level].cls}>{st.level}</span>
                <span className="mono tnum sr-pts">{st.avg.toFixed(0)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

Object.assign(window, { FeedbackPage, ToolsPage, ImportPage, SearchPage });
