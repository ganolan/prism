/* ============================================================================
   PRISM · Sunset — individual student page
   ============================================================================ */

function letterGradeFromCats(levels) {
  const L = window.PRISM.LEVEL_META;
  const vals = levels.filter(Boolean);
  if (!vals.length) return null;
  if (vals.includes('IE')) return 'F';
  const scaled = vals.reduce((s, l) => s + L[l].pts, 0) / vals.length / 25; // 0–4
  if (scaled >= 3.75) return 'A'; if (scaled >= 3.25) return 'A-';
  if (scaled >= 2.83) return 'B+'; if (scaled >= 2.33) return 'B'; if (scaled >= 2.0) return 'B-';
  if (scaled >= 1.75) return 'C+'; if (scaled >= 1.25) return 'C'; if (scaled >= 1.0) return 'D';
  return 'F';
}

function StudentTrend({ sid }) {
  const D = window.PRISM;
  const { node, bind } = useTip();
  const data = D.assessments;
  const W = 520, H = 180, padL = 30, padR = 12, padT = 12, padB = 30;
  const iw = W - padL - padR, ih = H - padT - padB;
  const xs = i => padL + (i / (data.length - 1)) * iw;
  const ys = v => padT + ih - (v / 100) * ih;
  const stu = data.map((a, i) => ({ a, i, score: D.studentAssessmentScore(sid, a.id), mean: D.trend[i].mean }));
  const sLine = stu.map(d => `${xs(d.i)},${ys(d.score)}`).join(' ');
  const cLine = stu.map(d => `${xs(d.i)},${ys(d.mean)}`).join(' ');
  return (
    <div className="card">
      <div className="card-head">
        <h3>Performance trend</h3>
        <span className="spacer" />
        <span className="legend-dot" style={{ color: 'var(--accent)' }}>● student</span>
        <span className="legend-dot" style={{ color: 'var(--text-faint)' }}>● class mean</span>
      </div>
      <div className="card-pad">
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
          {RUBRIC_BANDS.map(b => (
            <line key={b.l} x1={padL} x2={W - padR} y1={ys(b.y)} y2={ys(b.y)} stroke="var(--hairline)" strokeDasharray="3 5" />
          ))}
          <polyline points={cLine} fill="none" stroke="var(--text-faint)" strokeWidth="1.6" strokeDasharray="4 4" />
          <polyline points={sLine} fill="none" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          {stu.map(d => (
            <g key={d.a.id} {...bind(<span><b>{d.a.title}</b> · {d.a.date}<br />student {d.score} · class mean {d.mean}</span>)}>
              <rect x={xs(d.i) - 12} y={padT} width="24" height={ih} fill="transparent" />
              <circle cx={xs(d.i)} cy={ys(d.score)} r="4" fill="var(--accent)" stroke="var(--card-bg)" strokeWidth="2" />
              <text x={xs(d.i)} y={H - 8} fontSize="9" textAnchor="middle" fill="var(--text-faint)" className="mono">{d.a.date}</text>
            </g>
          ))}
        </svg>
      </div>
      {node}
    </div>
  );
}

function StudentPage({ sid, openStudent }) {
  const D = window.PRISM;
  const s = D.students.find(x => x.id === sid) || D.students[0];
  const st = D.studentStats(s.id);
  const cats = D.categories.map(c => ({ c, cs: D.studentCategory(s.id, c.id) }));
  const letter = letterGradeFromCats(cats.map(x => x.cs.level));
  const fb = D.studentFeedback(s.id);
  const ordered = [...D.students].sort((a, b) => a.name.localeCompare(b.name));
  const idx = ordered.findIndex(x => x.id === s.id);
  const prev = ordered[(idx - 1 + ordered.length) % ordered.length];
  const next = ordered[(idx + 1) % ordered.length];

  // box plot: class per assessment + this student's score marker
  const prevNext = null;

  return (
    <div className="fade-in">
      <div className="page-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button className="btn ghost" onClick={() => openStudent(null)}><Icon name="chevR" style={{ transform: 'rotate(180deg)' }} /> Roster</button>
          <Avatar s={s} size={52} />
          <div>
            <h1 className="page-title" style={{ marginBottom: 2 }}>{s.name}</h1>
            <div className="page-sub" style={{ margin: 0 }}>
              <span className="mono">{s.id}</span> · {D.course.name} · {D.course.section}
              {s.flags.includes('support') && <span className="status risk" style={{ marginLeft: 10 }}><Icon name="flag" style={{ width: 12, height: 12 }} /> Support plan</span>}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="icon-btn" title={'Previous: ' + prev.name} onClick={() => openStudent(prev.id)}><Icon name="chevR" style={{ transform: 'rotate(180deg)' }} /></button>
          <button className="icon-btn" title={'Next: ' + next.name} onClick={() => openStudent(next.id)}><Icon name="chevR" /></button>
        </div>
      </div>

      {/* summary strip */}
      <div className="stu-summary">
        <div className="card card-pad stu-overall">
          <div className="stat-label">Overall mastery</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0' }}>
            <span className="stat-value mono">{st.avg.toFixed(0)}</span>
            <span className={'mchip ' + D.LEVEL_META[st.level].cls} style={{ fontSize: 13, padding: '3px 9px' }}>{st.level}</span>
          </div>
          <div className="stat-foot">{D.LEVEL_META[st.level].name}</div>
        </div>
        <div className="card card-pad stu-letter">
          <div className="stat-label">Projected grade</div>
          <div className="stu-letter-val">{letter}</div>
          <div className="stat-foot">across {cats.length} reporting categories</div>
        </div>
        {cats.map(({ c, cs }) => (
          <div className="card card-pad stu-cat" key={c.id}>
            <div className="stat-label" title={c.title}>{c.code}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '5px 0' }}>
              {cs.level ? <span className={'mchip ' + D.LEVEL_META[cs.level].cls}>{cs.level}</span> : <span className="rt-dash">—</span>}
              <span className="mono tnum" style={{ color: 'var(--text-muted)', fontSize: 13 }}>{cs.avg != null ? cs.avg.toFixed(0) : ''}</span>
            </div>
            <div className="stu-cat-name">{c.title}</div>
          </div>
        ))}
      </div>

      {/* standards detail by category */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h3>Standards detail</h3><span className="sub">current mastery level per measurement topic</span><span className="spacer" /><MasteryLegend compact /></div>
        <div className="card-pad stu-standards">
          {cats.map(({ c, cs }) => (
            <div className="stu-stdcat" key={c.id}>
              <div className="stu-stdcat-head">
                <span className="eyebrow">{c.code} · {c.title}</span>
                {cs.level && <span className={'mchip ' + D.LEVEL_META[cs.level].cls}>{cs.level}</span>}
              </div>
              <div className="stu-topics">
                {c.topics.map(tp => {
                  const lv = D.grid[s.id][`${c.id}-${tp.code}`];
                  return (
                    <div className="stu-topic" key={tp.code}>
                      <span className="stu-topic-code mono">{tp.code}</span>
                      <span className="stu-topic-title">{tp.title}</span>
                      <span className={'mchip ' + (lv ? D.LEVEL_META[lv].cls : 'm-none')}>{lv || '·'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* discrete distribution vs class + trend */}
      <div style={{ marginBottom: 16 }}>
        <DotDistribution highlightId={s.id} />
      </div>

      <div className="grid-2 gap" style={{ marginTop: 0 }}>
        <StudentTrend sid={s.id} />
        <div className="card">
          <div className="card-head"><h3>Teacher focus</h3><span className="sub">auto-flagged from mastery</span></div>
          <div className="card-pad stu-focus">
            {fb.map((f, i) => (
              <div className={'stu-focus-row ' + f.kind} key={i}>
                <div className="stu-focus-top">
                  <span className={'tag ' + (f.kind === 'strength' ? 'formative' : 'summative')}>{f.kind === 'strength' ? 'Strength' : 'Focus'}</span>
                  <span className="mono stu-focus-code">{f.topic.code}</span>
                  <span className={'mchip ' + D.LEVEL_META[f.level].cls} style={{ marginLeft: 'auto' }}>{f.level}</span>
                </div>
                <p className="stu-focus-text">{f.text}</p>
              </div>
            ))}
            <button className="btn" style={{ alignSelf: 'flex-start' }}><Icon name="chat" /> Draft feedback</button>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { StudentPage, StudentTrend, letterGradeFromCats });
