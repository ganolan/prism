/* ============================================================================
   PRISM · Sunset — visualizations
   StatStrip · ClassDistribution · StandardBreakdown · TrendChart
   ============================================================================ */

/* ── stat strip ───────────────────────────────────────────────────────────── */
function StatStrip() {
  const D = window.PRISM;
  const total = D.students.length;
  const cls = D.pointsToLevel(D.classAvg);
  const onTrack = D.classCounts.EX + D.classCounts.ED;
  const atRisk = D.classCounts.IE + D.classCounts.EM;
  const pctOnTrack = Math.round((onTrack / D.classN) * 100);
  const pctRisk = Math.round((atRisk / D.classN) * 100);
  const totalCells = total * D.topics.length;
  const assessedPct = Math.round((D.classN / totalCells) * 100);
  const weak = [...D.topicStatList].sort((a, b) => a.avg - b.avg)[0];

  const items = [
    { label: 'Students', value: total, foot: D.course.section + ' · ' + D.course.room, accent: 'var(--violet)' },
    { label: 'Class mastery', value: D.classAvg.toFixed(0), chip: cls, foot: D.LEVEL_META[cls].name },
    { label: 'On track', value: pctOnTrack + '%', foot: onTrack + ' scores at EX / ED', bar: pctOnTrack, tone: 'var(--m-ed-ln)' },
    { label: 'Needs support', value: pctRisk + '%', foot: atRisk + ' scores at IE / EM', bar: pctRisk, tone: 'var(--accent)' },
    { label: 'Weakest standard', value: weak.code, foot: weak.title, chipSm: weak.level },
    { label: 'Coverage', value: assessedPct + '%', foot: 'of ' + totalCells + ' cells assessed', bar: assessedPct, tone: 'var(--m-ex-ln)' },
  ];

  return (
    <div className="stat-strip">
      {items.map((it, i) => (
        <div className="card stat" key={i}>
          <div className="stat-label">{it.label}</div>
          <div className="stat-row">
            <span className="stat-value mono">{it.value}</span>
            {it.chip && <span className={'mchip ' + window.PRISM.LEVEL_META[it.chip].cls}>{it.chip}</span>}
            {it.chipSm && <span className={'mchip ' + window.PRISM.LEVEL_META[it.chipSm].cls} style={{ fontSize: 10 }}>{it.chipSm}</span>}
          </div>
          {it.bar != null && (
            <div className="stat-bar"><i style={{ width: it.bar + '%', background: it.tone }} /></div>
          )}
          <div className="stat-foot">{it.foot}</div>
        </div>
      ))}
    </div>
  );
}

/* ── class-wide level distribution (one stacked bar) ──────────────────────── */
function ClassDistribution() {
  const D = window.PRISM;
  const { node, bind } = useTip();
  const order = ['IE', 'EM', 'D', 'EX', 'ED'];
  const total = D.classN;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Class mastery distribution</h3>
        <span className="sub">{total} scored cells</span>
        <span className="spacer" />
        <MasteryLegend compact />
      </div>
      <div className="card-pad">
        <div className="dist-bar">
          {order.map(lv => {
            const c = D.classCounts[lv];
            const pct = (c / total) * 100;
            if (!c) return null;
            const m = D.LEVEL_META[lv];
            return (
              <div key={lv} className={'dist-seg ' + m.cls} style={{ width: pct + '%' }}
                   {...bind(<span><b>{lv}</b> · {m.name}<br />{c} scores · {pct.toFixed(0)}%</span>)}>
                {pct > 7 && <span>{Math.round(pct)}%</span>}
              </div>
            );
          })}
        </div>
        <div className="dist-ticks">
          {order.map(lv => (
            <div key={lv} className="dist-tick">
              <span className={'mchip ' + D.LEVEL_META[lv].cls} style={{ minWidth: 22 }}>{lv}</span>
              <span className="mono tnum">{D.classCounts[lv]}</span>
            </div>
          ))}
        </div>
      </div>
      {node}
    </div>
  );
}

/* ── per-standard weakness breakdown (the priority viz) ───────────────────── */
function StandardBreakdown({ onPick, picked }) {
  const D = window.PRISM;
  const [sort, setSort] = useState('weak');
  const { node, bind } = useTip();
  const order = ['IE', 'EM', 'D', 'EX', 'ED'];

  let rows = [...D.topicStatList];
  if (sort === 'weak') rows.sort((a, b) => a.avg - b.avg);
  else if (sort === 'cat') rows.sort((a, b) => a.ci - b.ci || a.code.localeCompare(b.code));
  else if (sort === 'cov') rows.sort((a, b) => a.n - b.n);

  return (
    <div className="card">
      <div className="card-head">
        <h3>Standard mastery breakdown</h3>
        <span className="sub">where the class is strong &amp; weak</span>
        <span className="spacer" />
        <div className="seg">
          {[['weak', 'Weakest first'], ['cat', 'By category'], ['cov', 'By coverage']].map(([k, l]) => (
            <button key={k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="card-pad" style={{ paddingTop: 6 }}>
        <div className="brk">
          {rows.map(t => {
            const risk = t.pctProf < 0.34;
            return (
              <div key={t.id}
                   className={'brk-row' + (picked === t.id ? ' picked' : '')}
                   onClick={() => onPick && onPick(picked === t.id ? null : t.id)}>
                <div className="brk-label">
                  {risk && <span className="brk-dot" title="Fewer than a third of students proficient" />}
                  <span className="brk-code mono">{t.code}</span>
                  <span className="brk-title" title={t.title}>{t.title}</span>
                </div>
                <div className="brk-bar" {...bind(
                  <span><b>{t.catCode} · {t.code}</b> {t.title}<br />
                  {order.slice().reverse().map(lv => `${lv} ${t.counts[lv]}`).join('  ·  ')}<br />
                  avg {t.avg.toFixed(0)} · {Math.round(t.pctProf * 100)}% proficient · n={t.n}</span>
                )}>
                  {order.map(lv => {
                    const c = t.counts[lv];
                    if (!c) return null;
                    return <span key={lv} className={'brk-seg ' + D.LEVEL_META[lv].cls} style={{ flexGrow: c }} />;
                  })}
                </div>
                <div className="brk-meta">
                  <span className="mono tnum brk-prof" style={{ color: risk ? 'var(--accent)' : 'var(--text-muted)' }}>{Math.round(t.pctProf * 100)}%</span>
                  <span className={'mchip ' + D.LEVEL_META[t.level].cls}>{t.level}</span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="brk-foot">
          <span><span className="mono">%</span> = share of students at <b>Exhibiting</b> or above</span>
          <MasteryLegend compact />
        </div>
      </div>
      {node}
    </div>
  );
}

/* ── trend chart (class mean across assessments, ±SD band) ────────────────── */
function TrendChart() {
  const D = window.PRISM;
  const { node, bind } = useTip();
  const data = D.trend;
  const W = 560, H = 220, padL = 34, padR = 14, padT = 14, padB = 34;
  const iw = W - padL - padR, ih = H - padT - padB;
  const xs = i => padL + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const ys = v => padT + ih - (v / 100) * ih;
  const line = data.map((d, i) => `${xs(i)},${ys(d.mean)}`).join(' ');
  const bandTop = data.map((d, i) => `${xs(i)},${ys(Math.min(100, d.mean + d.sd))}`);
  const bandBot = data.map((d, i) => `${xs(i)},${ys(Math.max(0, d.mean - d.sd))}`).reverse();
  const band = [...bandTop, ...bandBot].join(' ');
  const levelLines = [{ y: 87.5, l: 'ED' }, { y: 62.5, l: 'EX' }, { y: 37.5, l: 'D' }, { y: 12.5, l: 'EM' }];

  return (
    <div className="card">
      <div className="card-head">
        <h3>Class mastery trend</h3>
        <span className="sub">mean ± 1 SD across {data.length} assessments</span>
        <span className="spacer" />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
          <Icon name="spark" style={{ width: 13, height: 13, color: 'var(--gold)' }} /> rising +20 pts
        </span>
      </div>
      <div className="card-pad">
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
          <defs>
            <linearGradient id="trendStroke" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--violet)" />
              <stop offset="55%" stopColor="var(--accent)" />
              <stop offset="100%" stopColor="var(--gold)" />
            </linearGradient>
          </defs>
          {levelLines.map(g => (
            <g key={g.l}>
              <line x1={padL} x2={W - padR} y1={ys(g.y)} y2={ys(g.y)} stroke="var(--hairline)" strokeDasharray="3 4" />
              <text x={6} y={ys(g.y) + 3} fontSize="9.5" fill="var(--text-faint)" className="mono">{g.l}</text>
            </g>
          ))}
          <polygon points={band} fill="var(--accent-quiet)" />
          <polyline points={line} fill="none" stroke="url(#trendStroke)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          {data.map((d, i) => (
            <g key={d.id} {...bind(<span><b>{d.title}</b> · {d.date}<br />mean {d.mean} · SD {d.sd} · {d.type}</span>)}>
              <rect x={xs(i) - 14} y={padT} width="28" height={ih} fill="transparent" />
              <circle cx={xs(i)} cy={ys(d.mean)} r="4.5" fill="var(--card-bg)" stroke="var(--accent)" strokeWidth="2.4" />
              <text x={xs(i)} y={H - 8} fontSize="9.5" textAnchor="middle" fill="var(--text-faint)" className="mono">{d.date}</text>
              {d.type === 'summative' && <rect x={xs(i) - 4} y={padT + ih + 5} width="8" height="3" rx="1.5" fill="var(--accent-line)" />}
            </g>
          ))}
        </svg>
      </div>
      {node}
    </div>
  );
}

Object.assign(window, { StatStrip, ClassDistribution, StandardBreakdown, TrendChart });
