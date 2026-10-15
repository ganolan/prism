/* ============================================================================
   PRISM · Sunset — app shell, Dashboard (Course Mastery), Tweaks
   ============================================================================ */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "twilight",
  "masteryPalette": "sunset",
  "density": "regular",
  "accent": "#c75a45"
}/*EDITMODE-END*/;

const MODE_ACCENT = { twilight: '#c75a45', orchid: '#b85aa0', dusk: '#d2734f' };

function Dashboard({ openStudent }) {
  const D = window.PRISM;
  const [picked, setPicked] = useState(null);
  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <div className="eyebrow">{D.course.code} · {D.course.term}</div>
          <h1 className="page-title">{D.course.name} <span style={{ color: 'var(--text-faint)', fontWeight: 600 }}>· {D.course.section}</span></h1>
          <p className="page-sub">Standards-based mastery across {D.topics.length} measurement topics in {D.categories.length} reporting categories.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn"><Icon name="download" /> Export</button>
          <button className="btn primary"><Icon name="book" /> Open gradebook</button>
        </div>
      </div>

      <StatStrip />

      <div className="dash-cols">
        <MasteryMatrix picked={picked} setPicked={setPicked} openStudent={openStudent} />
        <StandardBreakdown picked={picked} onPick={setPicked} />
      </div>

      <div className="grid-2 gap">
        <TrendChart />
        <ClassDistribution />
      </div>
    </div>
  );
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [route, setRoute] = useState('dashboard');
  const [studentId, setStudentId] = useState(null);

  useEffect(() => { document.documentElement.setAttribute('data-theme', t.theme); }, [t.theme]);
  useEffect(() => { document.documentElement.style.setProperty('--accent', t.accent); }, [t.accent]);
  useEffect(() => { document.documentElement.setAttribute('data-density', t.density); }, [t.density]);
  useEffect(() => { document.documentElement.setAttribute('data-mastery', t.masteryPalette); }, [t.masteryPalette]);

  const setMode = v => { setTweak('theme', v); setTweak('accent', MODE_ACCENT[v] || t.accent); };
  const openStudent = id => { if (id) { setStudentId(id); setRoute('student'); } else { setRoute('roster'); } };
  const go = r => { setRoute(r); window.scrollTo(0, 0); };

  const CRUMBS = {
    dashboard: ['Honors Biology', 'Mastery'], analytics: ['Honors Biology', 'Analytics'],
    roster: ['Honors Biology', 'Roster'], student: ['Honors Biology', 'Student'],
    search: ['Students', 'Search'], feedback: ['Workflow', 'Feedback Review'],
    tools: ['Workflow', 'Class Tools'], import: ['Workflow', 'Import CSV'],
  };

  let page;
  if (route === 'dashboard') page = <Dashboard openStudent={openStudent} />;
  else if (route === 'analytics') page = <AnalyticsPage />;
  else if (route === 'roster') page = <RosterPage openStudent={openStudent} />;
  else if (route === 'student') page = <StudentPage sid={studentId} openStudent={openStudent} />;
  else if (route === 'search') page = <SearchPage openStudent={openStudent} />;
  else if (route === 'feedback') page = <FeedbackPage openStudent={openStudent} />;
  else if (route === 'tools') page = <ToolsPage />;
  else if (route === 'import') page = <ImportPage />;

  return (
    <div className="app">
      <Sidebar route={route} setRoute={go} counts={{ feedback: 4 }} />
      <div className="main">
        <Topbar crumbs={CRUMBS[route] || CRUMBS.dashboard} theme={t.theme}
                onToggleTheme={() => setMode(t.theme === 'dusk' ? 'twilight' : 'dusk')} />
        <div className="content">{page}</div>
      </div>

      <TweaksPanel>
        <TweakSection label="Appearance" />
        <TweakRadio label="Mode" value={t.theme}
                    options={[{ value: 'twilight', label: 'Twilight' }, { value: 'orchid', label: 'Orchid' }, { value: 'dusk', label: 'Dusk' }]}
                    onChange={setMode} />
        <TweakColor label="Accent" value={t.accent}
                    options={['#c75a45', '#b85aa0', '#8a5fc4', '#cf7a3e', '#5b7fb5']}
                    onChange={v => setTweak('accent', v)} />
        <TweakSection label="Proficiency colors" />
        <TweakRadio label="Palette" value={t.masteryPalette}
                    options={[{ value: 'sunset', label: 'Sunset' }, { value: 'contrast', label: 'Contrast' }]}
                    onChange={v => setTweak('masteryPalette', v)} />
        <TweakSection label="Layout" />
        <TweakRadio label="Density" value={t.density} options={['compact', 'regular', 'comfy']}
                    onChange={v => setTweak('density', v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
