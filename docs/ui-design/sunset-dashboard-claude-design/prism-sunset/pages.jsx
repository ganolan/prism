/* ============================================================================
   PRISM · Sunset — Analytics & Roster pages
   ============================================================================ */

function CategorySummaryCards() {
  const D = window.PRISM;
  return (
    <div className="cat-cards">
      {D.categories.map(c => {
        let n = 0, sum = 0, prof = 0;
        c.topics.forEach(tp => {
          const ts = D.topicStats(`${c.id}-${tp.code}`);
          n += ts.n; sum += ts.avg * ts.n; prof += ts.proficient;
        });
        const avg = n ? sum / n : 0;
        const lv = D.pointsToLevel(avg);
        const pctProf = n ? Math.round((prof / n) * 100) : 0;
        const weakest = c.topics
          .map(tp => ({ tp, st: D.topicStats(`${c.id}-${tp.code}`) }))
          .sort((a, b) => a.st.avg - b.st.avg)[0];
        return (
          <div className="card card-pad cat-card" key={c.id}>
            <div className="cat-card-head">
              <span className="eyebrow">{c.code}</span>
              <span className={'mchip ' + D.LEVEL_META[lv].cls}>{lv}</span>
            </div>
            <div className="cat-card-title">{c.title}</div>
            <div className="cat-card-stat"><span className="mono">{pctProf}%</span> proficient · {c.topics.length} standards</div>
            <div className="cat-card-weak">weakest · <b>{weakest.tp.code}</b> {weakest.tp.title}</div>
          </div>
        );
      })}
    </div>
  );
}

function AnalyticsPage() {
  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <div className="eyebrow">{window.PRISM.course.code} · {window.PRISM.course.term}</div>
          <h1 className="page-title">Analytics</h1>
          <p className="page-sub">How {window.PRISM.course.name} is tracking against the mastery standards this term.</p>
        </div>
        <button className="btn"><Icon name="download" /> Export report</button>
      </div>
      <CategorySummaryCards />
      <div className="grid-2 gap">
        <TrendChart />
        <ClassDistribution />
      </div>
      <ScoreToProficiency />
      <DivergingBars />
    </div>
  );
}

/* ── Roster ───────────────────────────────────────────────────────────────── */
function RosterPage({ openStudent }) {
  const D = window.PRISM;
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('name');
  const [riskOnly, setRiskOnly] = useState(false);

  let rows = D.students.map(s => ({ s, st: D.studentStats(s.id) }));
  if (q) rows = rows.filter(r => r.s.name.toLowerCase().includes(q.toLowerCase()));
  if (riskOnly) rows = rows.filter(r => r.st.avg < 50);
  if (sort === 'name') rows.sort((a, b) => a.s.name.localeCompare(b.s.name));
  else if (sort === 'mastery') rows.sort((a, b) => b.st.avg - a.st.avg);
  else if (sort === 'risk') rows.sort((a, b) => a.st.avg - b.st.avg);

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <div className="eyebrow">{D.course.code} · {D.course.section}</div>
          <h1 className="page-title">Roster</h1>
          <p className="page-sub">{D.students.length} students · per-category mastery rollup</p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="search" style={{ margin: 0, width: 240 }}>
            <Icon name="search" style={{ width: 15, height: 15 }} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a student…" />
          </div>
          <button className={'pill' + (riskOnly ? ' on' : '')} onClick={() => setRiskOnly(v => !v)}>
            <Icon name="flag" style={{ width: 13, height: 13 }} /> Needs support
          </button>
          <span className="spacer" />
          <div className="seg">
            {[['name', 'A–Z'], ['mastery', 'Top'], ['risk', 'At risk']].map(([k, l]) => (
              <button key={k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>{l}</button>
            ))}
          </div>
        </div>
        <div className="rt-scroll">
          <table className="rt">
            <thead>
              <tr>
                <th className="rt-stu">Student</th>
                <th>Overall</th>
                {D.categories.map(c => <th key={c.id} title={c.title}>{c.code}</th>)}
                <th>Coverage</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ s, st }) => {
                const cov = Math.round(((D.topics.length - st.gaps) / D.topics.length) * 100);
                const risk = st.avg < 50;
                return (
                  <tr key={s.id} className="rt-clickable" onClick={() => openStudent && openStudent(s.id)}>
                    <th className="rt-stu">
                      <Avatar s={s} size={28} />
                      <div>
                        <div className="rt-name">{s.name}</div>
                        <div className="rt-id mono">{s.id}</div>
                      </div>
                    </th>
                    <td>
                      <span className={'mchip ' + D.LEVEL_META[st.level].cls}>{st.level}</span>
                      <span className="mono tnum rt-pts">{st.avg.toFixed(0)}</span>
                    </td>
                    {D.categories.map(c => {
                      let n = 0, sum = 0;
                      c.topics.forEach(tp => { const lv = D.grid[s.id][`${c.id}-${tp.code}`]; if (lv) { n++; sum += D.LEVEL_META[lv].pts; } });
                      const lv = n ? D.pointsToLevel(sum / n) : null;
                      return <td key={c.id}>{lv ? <span className={'mchip ' + D.LEVEL_META[lv].cls} style={{ minWidth: 22 }}>{lv}</span> : <span className="rt-dash">—</span>}</td>;
                    })}
                    <td>
                      <div className="rt-cov">
                        <div className="rt-cov-bar"><i style={{ width: cov + '%' }} /></div>
                        <span className="mono tnum">{cov}%</span>
                      </div>
                    </td>
                    <td>
                      {risk
                        ? <span className="status risk"><Icon name="flag" style={{ width: 12, height: 12 }} /> Needs support</span>
                        : <span className="status ok">On track</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { AnalyticsPage, RosterPage, CategorySummaryCards });
