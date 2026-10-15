/* ============================================================================
   PRISM · Sunset — mastery heatmap matrix (students × standards, filled cells)
   ============================================================================ */

function MasteryMatrix({ picked, setPicked, openStudent }) {
  const D = window.PRISM;
  const [sort, setSort] = useState('name');      // name | mastery | gaps
  const [catFilter, setCatFilter] = useState('all');
  const [showCodes, setShowCodes] = useState(true);
  const [hoverRow, setHoverRow] = useState(null);
  const { node, bind } = useTip();

  // visible topics (by category filter)
  const topics = D.topics.filter(t => catFilter === 'all' || t.catId === catFilter);
  const cats = D.categories.filter(c => catFilter === 'all' || c.id === catFilter);

  // student order
  const withStats = D.students.map(s => ({ s, st: D.studentStats(s.id) }));
  let rows = [...withStats];
  if (sort === 'name') rows.sort((a, b) => a.s.name.localeCompare(b.s.name));
  else if (sort === 'mastery') rows.sort((a, b) => b.st.avg - a.st.avg);
  else if (sort === 'gaps') rows.sort((a, b) => b.st.gaps - a.st.gaps || a.st.avg - b.st.avg);

  const colCount = topics.length;

  function Cell({ sid, t }) {
    const lv = D.grid[sid][t.id];
    const m = lv ? D.LEVEL_META[lv] : null;
    const dim = picked && picked !== t.id;
    const stu = D.students.find(x => x.id === sid);
    return (
      <td className={'mx-cell' + (picked === t.id ? ' col-pick' : '') + (dim ? ' dim' : '')}>
        <span className={'mx-fill ' + (m ? m.cls : 'm-none')}
              {...bind(<span><b>{stu.name}</b><br />{t.catCode} · {t.code} {t.title}<br />{m ? `${lv} — ${m.name}` : 'Not yet assessed'}</span>)}>
          {lv ? (showCodes ? lv : '') : (showCodes ? '·' : '')}
        </span>
      </td>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>Mastery heatmap</h3>
        <span className="sub">{D.students.length} students × {D.topics.length} standards</span>
        <span className="spacer" />
        <div className="seg">
          {[['name', 'A–Z'], ['mastery', 'By mastery'], ['gaps', 'By gaps']].map(([k, l]) => (
            <button key={k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>
              {k === 'name' ? null : <Icon name="sort" />}{l}
            </button>
          ))}
        </div>
        <button className={'pill' + (showCodes ? ' on' : '')} onClick={() => setShowCodes(v => !v)}>
          {showCodes ? 'Codes' : 'Color only'}
        </button>
      </div>

      <div className="card-pad" style={{ paddingTop: 10, paddingBottom: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', borderBottom: '1px solid var(--hairline)' }}>
        <Icon name="filter" style={{ width: 14, height: 14, color: 'var(--text-faint)' }} />
        <button className={'pill' + (catFilter === 'all' ? ' on' : '')} onClick={() => setCatFilter('all')}>All categories</button>
        {D.categories.map(c => (
          <button key={c.id} className={'pill' + (catFilter === c.id ? ' on' : '')} onClick={() => setCatFilter(c.id)}>{c.code} · {c.title}</button>
        ))}
        {picked && (
          <button className="pill on" style={{ marginLeft: 'auto', background: 'var(--violet)' }} onClick={() => setPicked(null)}>
            Focus: {D.topics.find(t => t.id === picked)?.code} ✕
          </button>
        )}
      </div>

      <div className="mx-scroll">
        <table className="mx" style={{ '--cols': colCount }}>
          <thead>
            <tr className="mx-cats">
              <th className="mx-corner" rowSpan="2">Student</th>
              {cats.map(c => (
                <th key={c.id} className="mx-cat" colSpan={c.topics.length}>
                  <span>{c.code} · {c.title}</span>
                </th>
              ))}
              <th className="mx-roll" rowSpan="2">Avg</th>
            </tr>
            <tr className="mx-topics">
              {topics.map(t => (
                <th key={t.id}
                    className={'mx-th' + (picked === t.id ? ' col-pick' : '')}
                    onClick={() => setPicked(picked === t.id ? null : t.id)}
                    {...bind(<span><b>{t.code}</b> {t.title}<br />class avg {t.code ? '' : ''}{D.topicStats(t.id).avg.toFixed(0)} · {Math.round(D.topicStats(t.id).pctProf * 100)}% proficient</span>)}>
                  <span className="mono">{t.code}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ s, st }) => (
              <tr key={s.id} className={hoverRow === s.id ? 'row-hover' : ''}
                  onMouseEnter={() => setHoverRow(s.id)} onMouseLeave={() => setHoverRow(null)}>
                <th className="mx-name">
                  <div className="mx-name-inner mx-name-link" onClick={() => openStudent && openStudent(s.id)} title={'Open ' + s.name}>
                    <Avatar s={s} size={22} />
                    <span className="mx-name-txt">
                      <span className="nm">{s.name}</span>
                      {st.gaps > 0 && <i className="mx-gap" title={st.gaps + ' standards not yet assessed'}>{st.gaps}</i>}
                    </span>
                  </div>
                </th>
                {topics.map(t => <Cell key={t.id} sid={s.id} t={t} />)}
                <td className="mx-avg">
                  <span className={'mchip ' + D.LEVEL_META[st.level].cls}>{st.level}</span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="mx-foot">
              <th className="mx-name mx-foot-lbl">Class avg</th>
              {topics.map(t => {
                const ts = D.topicStats(t.id);
                return (
                  <td key={t.id} className={'mx-cell' + (picked === t.id ? ' col-pick' : '')}>
                    <span className={'mchip ' + D.LEVEL_META[ts.level].cls} style={{ minWidth: 22, fontSize: 10 }}
                          {...bind(<span><b>{t.code}</b> {t.title}<br />avg {ts.avg.toFixed(0)} · {Math.round(ts.pctProf * 100)}% proficient</span>)}>
                      {ts.level}
                    </span>
                  </td>
                );
              })}
              <td className="mx-avg" />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="card-pad" style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 12 }}>
        <MasteryLegend />
        <span className="spacer" style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Click a column to focus a standard · hover a cell for detail</span>
      </div>
      {node}
    </div>
  );
}

Object.assign(window, { MasteryMatrix });
