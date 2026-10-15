/* ============================================================================
   PRISM · Sunset — shared UI (icons, sidebar, topbar, stat cards, legend)
   Exposes components on window for the other Babel scripts.
   ============================================================================ */
const { useState, useRef, useEffect } = React;

/* ── icons (simple stroke UI glyphs) ──────────────────────────────────────── */
const P = (d, fill) => ({ d, fill });
function Icon({ name, style }) {
  const I = {
    grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
    search: 'M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0 M21 21l-4.3-4.3',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
    chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    tools: 'M14.7 6.3a4 4 0 0 0-5.6 5.4L3 18v3h3l6.3-6.1a4 4 0 0 0 5.4-5.6l-2.7 2.7-2.1-.6-.6-2.1z',
    upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12',
    bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9 M13.7 21a2 2 0 0 1-3.4 0',
    sync: 'M3 12a9 9 0 0 1 15-6.7L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15 6.7L3 16 M3 21v-5h5',
    sun: 'M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0 M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
    chart: 'M3 3v18h18 M7 14l3-3 3 3 4-5',
    layers: 'M12 2 2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5',
    book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
    filter: 'M22 3H2l8 9.46V19l4 2v-8.54z',
    sort: 'M11 5h10 M11 9h7 M11 13h4 M3 17l3 3 3-3 M6 18V4',
    download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
    flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z M4 22v-7',
    chevR: 'M9 18l6-6-6-6',
    chevD: 'M6 9l6 6 6-6',
    info: 'M12 12m-10 0a10 10 0 1 0 20 0a10 10 0 1 0-20 0 M12 16v-4 M12 8h.01',
    spark: 'M12 3l1.9 5.8H20l-4.9 3.6 1.9 5.8-5-3.6-5 3.6 1.9-5.8L4 8.8h6.1z',
    dots: 'M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0 M19 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0 M5 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d={I[name] || ''} />
    </svg>
  );
}

/* ── Prism logo mark — white light refracting into the mastery spectrum ───── */
function PrismMark({ size = 30 }) {
  return (
    <svg className="prism-mark" viewBox="0 0 38 32" fill="none" style={{ width: size, height: size * 32 / 38 }}>
      {/* incoming white light */}
      <path d="M1 14.5 H13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.6" />
      <path d="M2 19 H13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.32" />
      {/* refracted spectrum (mastery hues IE→ED) */}
      <path d="M12.5 16.5 L37 8"  stroke="var(--m-ed-ln)" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M12.5 16.5 L37 13" stroke="var(--m-ex-ln)" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M12.5 16.5 L37 18" stroke="var(--m-d-ln)"  strokeWidth="1.9" strokeLinecap="round" />
      <path d="M12.5 16.5 L37 23" stroke="var(--m-em-ln)" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M12.5 16.5 L37 28" stroke="var(--m-ie-ln)" strokeWidth="1.9" strokeLinecap="round" />
      {/* prism */}
      <path d="M19 3 L31 28 L7 28 Z" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
    </svg>
  );
}

/* ── avatar ───────────────────────────────────────────────────────────────── */
function Avatar({ s, size = 26 }) {
  return (
    <span className="avatar" style={{ width: size, height: size, background: s.color, fontSize: size * 0.4 }}>
      {s.initials}
    </span>
  );
}

/* ── sidebar ──────────────────────────────────────────────────────────────── */
function Sidebar({ route, setRoute, counts }) {
  const nav = [
    { id: 'dashboard', icon: 'grid', label: 'Course Mastery' },
    { id: 'analytics', icon: 'chart', label: 'Analytics' },
    { id: 'roster', icon: 'users', label: 'Roster' },
    { id: 'search', icon: 'search', label: 'Search Students' },
  ];
  const tools = [
    { id: 'feedback', icon: 'chat', label: 'Feedback Review', badge: counts.feedback },
    { id: 'tools', icon: 'tools', label: 'Class Tools' },
    { id: 'import', icon: 'upload', label: 'Import CSV' },
  ];
  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="brand-mark"><PrismMark size={30} /></span>
        <span className="brand-name">Prism<span className="sub"></span></span>
      </div>

      <div className="nav-label">Course</div>
      {nav.map(n => (
        <button key={n.id} className={'nav-item' + (route === n.id ? ' active' : '')} onClick={() => setRoute(n.id)}>
          <Icon name={n.icon} /> {n.label}
        </button>
      ))}

      <div className="nav-label">Workflow</div>
      {tools.map(n => (
        <button key={n.id} className={'nav-item' + (route === n.id ? ' active' : '')} onClick={() => setRoute(n.id)}>
          <Icon name={n.icon} /> {n.label}
          {n.badge ? <span className="nav-badge">{n.badge}</span> : null}
        </button>
      ))}

      <div className="nav-spacer" />

      <div className="side-card">
        <div className="row"><span>Term sync</span><b>2h ago</b></div>
        <div className="side-meter"><i style={{ width: '92%' }} /></div>
        <div className="row" style={{ margin: '8px 0 0', fontSize: 11 }}><span>412 records · Schoology</span></div>
      </div>

      <div className="side-user">
        <span className="av">MV</span>
        <span className="nm"><b>M. Vásquez</b><span>Science · Grade 10</span></span>
      </div>
    </nav>
  );
}

/* ── topbar ───────────────────────────────────────────────────────────────── */
function Topbar({ crumbs, theme, onToggleTheme }) {
  return (
    <header className="topbar">
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="sep">/</span>}
            {i === crumbs.length - 1 ? <b>{c}</b> : <span>{c}</span>}
          </React.Fragment>
        ))}
      </div>
      <div className="search">
        <Icon name="search" style={{ width: 15, height: 15 }} />
        <input placeholder="Search students, standards…" />
        <kbd>⌘K</kbd>
      </div>
      <button className="icon-btn" title="Toggle theme" onClick={onToggleTheme}>
        <Icon name={theme === 'dusk' ? 'sun' : 'moon'} />
      </button>
      <button className="icon-btn" title="Notifications"><Icon name="bell" /><span className="dot" /></button>
      <button className="btn primary"><Icon name="sync" /> Sync</button>
    </header>
  );
}

/* ── mastery legend ───────────────────────────────────────────────────────── */
function MasteryLegend({ compact }) {
  const { LEVELS, LEVEL_META } = window.PRISM;
  return (
    <div style={{ display: 'flex', gap: compact ? 8 : 14, alignItems: 'center', flexWrap: 'wrap' }}>
      {[...LEVELS].reverse().map(lv => {
        const m = LEVEL_META[lv];
        return (
          <span key={lv} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600 }}>
            <span className={'mchip ' + m.cls} style={{ minWidth: 22, padding: '1px 5px' }}>{lv}</span>
            {!compact && m.name}
          </span>
        );
      })}
    </div>
  );
}

/* ── tiny tooltip hook ────────────────────────────────────────────────────── */
function useTip() {
  const [tip, setTip] = useState(null);
  const node = tip ? <div className="tip" style={{ left: tip.x, top: tip.y }}>{tip.content}</div> : null;
  const bind = (content) => ({
    onMouseMove: (e) => setTip({ x: Math.min(e.clientX + 14, window.innerWidth - 300), y: e.clientY + 16, content }),
    onMouseLeave: () => setTip(null),
  });
  return { node, bind };
}

Object.assign(window, { Icon, Avatar, PrismMark, Sidebar, Topbar, MasteryLegend, useTip });
