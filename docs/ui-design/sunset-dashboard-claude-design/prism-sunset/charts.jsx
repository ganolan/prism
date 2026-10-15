/* ============================================================================
   PRISM · Sunset — discrete + continuous analytics
   The grade is built from DISCRETE proficiencies (IE→ED) that are derived,
   via standards rubrics, from a mix of CONTINUOUS evidence (test scores) and
   discrete rubric judgments. So:
     • continuous evidence  → histogram with rubric bands (ScoreToProficiency)
     • discrete proficiency → diverging Likert bars (DivergingBars)
                            → unit/dot chart (DotDistribution)
   ============================================================================ */

const RUBRIC_BANDS = [
  { y: 87.5, l: 'ED' }, { y: 62.5, l: 'EX' }, { y: 37.5, l: 'D' }, { y: 12.5, l: 'EM' },
];
// rubric cut-points mapping a 0–100 score to a level band
const RUBRIC_CUTS = [
  { lo: 0,    hi: 12.5,  lv: 'IE' },
  { lo: 12.5, hi: 37.5,  lv: 'EM' },
  { lo: 37.5, hi: 62.5,  lv: 'D'  },
  { lo: 62.5, hi: 87.5,  lv: 'EX' },
  { lo: 87.5, hi: 100,   lv: 'ED' },
];

/* ── 1 · Score → Proficiency ──────────────────────────────────────────────
   Continuous test-score histogram, shaded by the rubric band each score falls
   into. Shows exactly how continuous evidence is binned into discrete levels. */
function ScoreToProficiency() {
  const D = window.PRISM;
  const { node, bind } = useTip();
  const [aid, setAid] = useState('a3');
  const assess = D.assessments.find(a => a.id === aid) || D.assessments[0];
  const scores = D.assessmentScores[assess.id];

  // histogram: 20 bins of width 5
  const nb = 20, bw = 5;
  const bins = Array.from({ length: nb }, () => 0);
  scores.forEach(s => { bins[Math.min(nb - 1, Math.floor(s / bw))]++; });
  const maxC = Math.max(...bins, 1);

  // resulting discrete tally
  const tally = { IE: 0, EM: 0, D: 0, EX: 0, ED: 0 };
  scores.forEach(s => tally[D.pointsToLevel(s)]++);
  const n = scores.length;

  const W = 620, H = 250, padL = 30, padR = 14, padT = 26, padB = 30;
  const iw = W - padL - padR, ih = H - padT - padB;
  const x = v => padL + (v / 100) * iw;
  const y = c => padT + ih - (c / maxC) * ih;

  return (
    <div className="card">
      <div className="card-head">
        <h3>Score → proficiency</h3>
        <span className="sub">continuous evidence, binned by the standard rubric</span>
        <span className="spacer" />
        <select className="s2p-select" value={aid} onChange={e => setAid(e.target.value)}>
          {D.assessments.map(a => <option key={a.id} value={a.id}>{a.date} · {a.title}</option>)}
        </select>
      </div>
      <div className="card-pad" style={{ display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--hairline)', paddingTop: 10, paddingBottom: 10 }}>
        <span className={'tag ' + (assess.type === 'summative' ? 'summative' : 'formative')}>{assess.type}</span>
        <span className="text-sm" style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>aligned to <b style={{ color: 'var(--text)' }}>{assess.cat}</b> · {D.categories.find(c => c.code === assess.cat)?.title}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="text-sm" style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>n = {n} students</span>
      </div>
      <div className="card-pad">
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
          {/* rubric bands */}
          {RUBRIC_CUTS.map(c => {
            const m = D.LEVEL_META[c.lv];
            return (
              <g key={c.lv}>
                <rect x={x(c.lo)} y={padT} width={x(c.hi) - x(c.lo)} height={ih} fill={`var(--${m.cls})`} opacity="0.22" />
                <text x={(x(c.lo) + x(c.hi)) / 2} y={padT - 9} fontSize="10" textAnchor="middle" fontWeight="700" fill={`var(--${m.cls}-tx)`}>{c.lv}</text>
              </g>
            );
          })}
          {/* cut lines */}
          {[12.5, 37.5, 62.5, 87.5].map(v => (
            <line key={v} x1={x(v)} x2={x(v)} y1={padT} y2={padT + ih} stroke="var(--border-strong)" strokeDasharray="2 3" strokeWidth="1" />
          ))}
          {/* bars */}
          {bins.map((c, i) => {
            if (!c) return null;
            const center = i * bw + bw / 2;
            const lv = D.pointsToLevel(center);
            return (
              <rect key={i} x={x(i * bw) + 1} y={y(c)} width={iw / nb - 2} height={padT + ih - y(c)} rx="2"
                    fill={`var(--${D.LEVEL_META[lv].cls}-ln)`}
                    {...bind(<span>scores {i * bw}–{i * bw + bw} → <b>{lv}</b><br />{c} student{c > 1 ? 's' : ''}</span>)} />
            );
          })}
          <line x1={padL} x2={W - padR} y1={padT + ih} y2={padT + ih} stroke="var(--border)" />
          {[0, 25, 50, 75, 100].map(v => <text key={v} x={x(v)} y={H - 10} fontSize="9.5" textAnchor="middle" fill="var(--text-faint)" className="mono">{v}</text>)}
        </svg>
        {/* resulting discrete proficiency */}
        <div className="s2p-result">
          <span className="s2p-arrow">resulting proficiency →</span>
          {['IE', 'EM', 'D', 'EX', 'ED'].map(lv => (
            <span key={lv} className="s2p-tile">
              <span className={'mchip ' + D.LEVEL_META[lv].cls}>{lv}</span>
              <b className="mono">{tally[lv]}</b>
            </span>
          ))}
        </div>
      </div>
      {node}
    </div>
  );
}

/* ── 2 · Proficiency by standard — diverging Likert bars ──────────────────── */
function DivergingBars() {
  const D = window.PRISM;
  const { node, bind } = useTip();
  const [sort, setSort] = useState('weak');
  let rows = D.topics.map(t => ({ t, ...D.topicStats(t.id) }));
  if (sort === 'weak') rows.sort((a, b) => a.pctProf - b.pctProf);
  else rows.sort((a, b) => a.ci - b.ci || a.code.localeCompare(b.code));

  const LEFT = ['IE', 'EM', 'D'];   // not yet proficient (grows left, D nearest centre)
  const RIGHT = ['EX', 'ED'];       // proficient (grows right, EX nearest centre)

  return (
    <div className="card">
      <div className="card-head">
        <h3>Proficiency by standard</h3>
        <span className="sub">anchored at the proficiency threshold · each segment = students</span>
        <span className="spacer" />
        <div className="seg">
          {[['weak', 'Weakest first'], ['cat', 'By category']].map(([k, l]) => (
            <button key={k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="dv-legend">
        <span className="dv-legend-side">◀ developing &amp; below</span>
        <MasteryLegend compact />
        <span className="dv-legend-side right">proficient ▶</span>
      </div>
      <div className="card-pad" style={{ paddingTop: 4 }}>
        <div className="dv">
          {rows.map(({ t, counts, n, pctProf, level }) => (
            <div className="dv-row" key={t.id}>
              <div className="dv-label">
                <span className="brk-code mono">{t.code}</span>
                <span className="brk-title" title={t.title}>{t.title}</span>
              </div>
              <div className="dv-track" {...bind(
                <span><b>{t.catCode} · {t.code}</b> {t.title}<br />
                  {['ED', 'EX', 'D', 'EM', 'IE'].map(l => `${l} ${counts[l]}`).join('  ·  ')}<br />
                  {Math.round(pctProf * 100)}% proficient · n={n}</span>
              )}>
                <div className="dv-half dv-left">
                  {LEFT.map((lv, i) => counts[lv] ? (
                    <span key={lv} className={'dv-seg ' + D.LEVEL_META[lv].cls}
                          style={{ width: (counts[lv] / n * 100) + '%', borderTopLeftRadius: i === 0 ? 4 : 0, borderBottomLeftRadius: i === 0 ? 4 : 0 }} />
                  ) : null)}
                </div>
                <div className="dv-axis" />
                <div className="dv-half dv-right">
                  {RIGHT.map((lv, i) => counts[lv] ? (
                    <span key={lv} className={'dv-seg ' + D.LEVEL_META[lv].cls}
                          style={{ width: (counts[lv] / n * 100) + '%', borderTopRightRadius: i === RIGHT.length - 1 ? 4 : 0, borderBottomRightRadius: i === RIGHT.length - 1 ? 4 : 0 }} />
                  ) : null)}
                </div>
              </div>
              <div className="dv-pct"><span className="mono tnum" style={{ color: pctProf < 0.34 ? 'var(--accent)' : 'var(--text-muted)' }}>{Math.round(pctProf * 100)}%</span></div>
            </div>
          ))}
        </div>
      </div>
      {node}
    </div>
  );
}

/* ── 3 · Dot distribution (unit chart) ────────────────────────────────────
   One dot per student, binned into discrete levels, per standard. Optional
   highlightId rings the focal student's dot. Honest about discreteness. */
function DotDistribution({ highlightId }) {
  const D = window.PRISM;
  const { node, bind } = useTip();
  const levels = ['ED', 'EX', 'D', 'EM', 'IE'];
  const stu = highlightId && D.students.find(s => s.id === highlightId);

  return (
    <div className="card">
      <div className="card-head">
        <h3>{stu ? `${stu.name.split(' ')[0]} vs class, by standard` : 'Class distribution by standard'}</h3>
        <span className="sub">one dot = one student{stu ? ' · ◉ = ' + stu.name.split(' ')[0] : ''}</span>
      </div>
      <div className="dd-scroll">
        <div className="dd" style={{ '--cols': D.topics.length }}>
          <div className="dd-corner" />
          {D.topics.map(t => (
            <div key={t.id} className="dd-colh" {...bind(<span><b>{t.catCode} · {t.code}</b> {t.title}</span>)}>
              <span className="mono">{t.code}</span>
            </div>
          ))}
          {levels.map(lv => (
            <React.Fragment key={lv}>
              <div className="dd-rowh"><span className={'mchip ' + D.LEVEL_META[lv].cls}>{lv}</span></div>
              {D.topics.map(t => {
                const c = D.topicStats(t.id).counts[lv];
                const mine = stu && D.grid[stu.id][t.id] === lv;
                const dots = [];
                for (let i = 0; i < c; i++) {
                  const isMine = mine && i === 0;
                  dots.push(<span key={i} className={'dd-dot ' + D.LEVEL_META[lv].cls + (isMine ? ' me' : '')} />);
                }
                return (
                  <div key={t.id} className="dd-cell"
                       {...bind(<span><b>{t.code}</b> · {D.LEVEL_META[lv].name}<br />{c} student{c !== 1 ? 's' : ''}{mine ? ` · incl. ${stu.name.split(' ')[0]}` : ''}</span>)}>
                    {dots}
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
      {node}
    </div>
  );
}

Object.assign(window, { RUBRIC_BANDS, RUBRIC_CUTS, ScoreToProficiency, DivergingBars, DotDistribution });
