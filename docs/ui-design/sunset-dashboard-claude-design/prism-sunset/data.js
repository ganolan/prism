/* ============================================================================
   PRISM · Sunset — mock data
   Mirrors the real Prism model: reporting categories → measurement topics,
   five mastery levels (IE → EM → D → EX → ED), per-student per-topic scores.
   Seeded generation so the "weak standards" are stable & meaningful.
   Exposes window.PRISM.
   ============================================================================ */
(function () {
  // ── mastery levels (matches src: LEVELS / LEVEL_POINTS) ──────────────────
  const LEVELS = ['IE', 'EM', 'D', 'EX', 'ED']; // ascending (worst → best)
  const LEVEL_META = {
    IE: { name: 'Insufficient Evidence', pts: 0,   cls: 'm-ie', i: 0 },
    EM: { name: 'Emerging',              pts: 25,  cls: 'm-em', i: 1 },
    D:  { name: 'Developing',            pts: 50,  cls: 'm-d',  i: 2 },
    EX: { name: 'Exhibiting',            pts: 75,  cls: 'm-ex', i: 3 },
    ED: { name: 'Exhibiting Depth',      pts: 100, cls: 'm-ed', i: 4 },
  };
  function pointsToLevel(p) {
    if (p == null) return null;
    if (p >= 87.5) return 'ED';
    if (p >= 62.5) return 'EX';
    if (p >= 37.5) return 'D';
    if (p >= 12.5) return 'EM';
    return 'IE';
  }

  // ── seeded RNG (mulberry32) ──────────────────────────────────────────────
  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = rng(20251031);
  const gauss = () => (rand() + rand() + rand() + rand() - 2) / 2; // ~N(0, .5)

  // ── course ───────────────────────────────────────────────────────────────
  const course = {
    name: 'Honors Biology',
    section: 'Block 3',
    term: 'Fall 2025 · Semester 1',
    code: 'SCI-BIO-H',
    room: 'Room 214',
  };

  // ── reporting categories → measurement topics ─────────────────────────────
  // `diff` (difficulty) tunes how hard a standard is → drives weak-standard story.
  const categories = [
    { id: 'c1', code: 'BIO.1', title: 'Cells & Energy', topics: [
      { code: '1.1', title: 'Cell Structure & Function', diff: -0.55 },
      { code: '1.2', title: 'Membrane Transport',        diff: -0.05 },
      { code: '1.3', title: 'Photosynthesis',            diff:  0.35 },
      { code: '1.4', title: 'Cellular Respiration',      diff:  0.62 },
    ]},
    { id: 'c2', code: 'BIO.2', title: 'Genetics & Heredity', topics: [
      { code: '2.1', title: 'DNA Structure',             diff: -0.35 },
      { code: '2.2', title: 'Replication',               diff:  0.15 },
      { code: '2.3', title: 'Protein Synthesis',         diff:  0.72 },
      { code: '2.4', title: 'Mendelian Inheritance',     diff:  0.45 },
    ]},
    { id: 'c3', code: 'BIO.3', title: 'Evolution & Ecology', topics: [
      { code: '3.1', title: 'Natural Selection',         diff: -0.15 },
      { code: '3.2', title: 'Phylogenetics',             diff:  0.6 },
      { code: '3.3', title: 'Ecosystems & Energy Flow',  diff: -0.25 },
      { code: '3.4', title: 'Population Dynamics',        diff:  0.30 },
    ]},
    { id: 'c4', code: 'SP', title: 'Science Practices', topics: [
      { code: 'SP.1', title: 'Experimental Design',      diff:  0.20 },
      { code: 'SP.2', title: 'Data Analysis',            diff: -0.10 },
      { code: 'SP.3', title: 'Argumentation w/ Evidence', diff: 0.8 },
    ]},
  ];

  // flat topic list with category back-ref
  const topics = [];
  categories.forEach((cat, ci) => {
    cat.topics.forEach(t => {
      topics.push({
        id: `${cat.id}-${t.code}`, code: t.code, title: t.title,
        diff: t.diff, catId: cat.id, catCode: cat.code, catTitle: cat.title, ci,
      });
    });
  });

  // ── students ───────────────────────────────────────────────────────────────
  const NAMES = [
    'Amara Okafor', 'Liam Chen', 'Sofia Reyes', 'Noah Patel', 'Mia Nakamura',
    'Ethan Brooks', 'Zoe Hassan', 'Lucas Martin', 'Ava Delgado', 'Kai Andersen',
    'Isabella Romano', 'Mason Wright', 'Layla Haddad', 'Oliver Fischer', 'Chloe Tan',
    'Diego Salazar', 'Harper Quinn', 'Ibrahim Nuri', 'Emma Larsson', 'Jayden Cole',
    'Priya Menon', 'Owen Mitchell', 'Nadia Petrova', 'Caleb Foster', 'Yuki Tanaka',
    'Grace Okonkwo',
  ];
  const AV = ['oklch(0.6 0.13 25)', 'oklch(0.58 0.11 300)', 'oklch(0.6 0.1 350)', 'oklch(0.62 0.1 62)', 'oklch(0.58 0.1 200)', 'oklch(0.6 0.1 145)'];
  const students = NAMES.map((name, i) => {
    const ability = gauss() * 1.05 + (i % 7 === 0 ? -0.7 : 0.15); // a few strugglers
    const parts = name.split(' ');
    return {
      id: 'S' + (1001 + i),
      name,
      initials: (parts[0][0] + parts[parts.length - 1][0]).toUpperCase(),
      color: AV[i % AV.length],
      ability,
      // light demographic-ish meta used in roster
      flags: rand() < 0.12 ? ['support'] : [],
    };
  });

  // ── scores: student × topic → level (with a little "not yet assessed") ─────
  // grid[studentId][topicId] = 'ED' | ... | 'IE' | null
  const grid = {};
  students.forEach(s => {
    grid[s.id] = {};
    topics.forEach(t => {
      // ungraded gaps: harder/later topics less likely assessed
      const assessed = rand() > (0.04 + Math.max(0, t.diff) * 0.06);
      if (!assessed) { grid[s.id][t.id] = null; return; }
      const z = s.ability - t.diff + gauss() * 0.9 + 0.6; // shift up a touch
      // map z (~ -2.5..3) to 0..4
      let idx;
      if (z < -1.05) idx = 0;
      else if (z < -0.15) idx = 1;
      else if (z < 0.7) idx = 2;
      else if (z < 1.5) idx = 3;
      else idx = 4;
      grid[s.id][t.id] = LEVELS[idx];
    });
  });

  // ── per-topic distribution + weakness score ────────────────────────────────
  function topicStats(topicId) {
    const counts = { IE: 0, EM: 0, D: 0, EX: 0, ED: 0 };
    let n = 0, sum = 0;
    students.forEach(s => {
      const lv = grid[s.id][topicId];
      if (lv) { counts[lv]++; n++; sum += LEVEL_META[lv].pts; }
    });
    const avg = n ? sum / n : 0;
    const proficient = counts.EX + counts.ED;          // EX or ED = "on track"
    const atRisk = counts.IE + counts.EM;              // IE or EM = needs support
    return { counts, n, avg, level: pointsToLevel(n ? avg : null), proficient, atRisk, pctProf: n ? proficient / n : 0 };
  }
  const topicStatList = topics.map(t => ({ ...t, ...topicStats(t.id) }));

  // ── per-student rollup (mean across topics) ────────────────────────────────
  function studentStats(sid) {
    let n = 0, sum = 0; const counts = { IE: 0, EM: 0, D: 0, EX: 0, ED: 0 };
    topics.forEach(t => { const lv = grid[sid][t.id]; if (lv) { counts[lv]++; n++; sum += LEVEL_META[lv].pts; } });
    const avg = n ? sum / n : 0;
    return { n, avg, level: pointsToLevel(n ? avg : null), counts, gaps: topics.length - n };
  }

  // ── class-wide level totals ────────────────────────────────────────────────
  const classCounts = { IE: 0, EM: 0, D: 0, EX: 0, ED: 0 };
  let classN = 0, classSum = 0;
  students.forEach(s => topics.forEach(t => {
    const lv = grid[s.id][t.id];
    if (lv) { classCounts[lv]++; classN++; classSum += LEVEL_META[lv].pts; }
  }));
  const classAvg = classSum / classN;

  // ── trend: class mastery average across the term's summatives ──────────────
  const assessments = [
    { id: 'a1', title: 'Cell Lab Practical',        type: 'summative', date: 'Sep 5',  cat: 'BIO.1' },
    { id: 'a2', title: 'Membrane Quiz',             type: 'formative', date: 'Sep 12', cat: 'BIO.1' },
    { id: 'a3', title: 'Energy Unit Test',          type: 'summative', date: 'Sep 26', cat: 'BIO.1' },
    { id: 'a4', title: 'DNA Modeling Project',      type: 'summative', date: 'Oct 10', cat: 'BIO.2' },
    { id: 'a5', title: 'Protein Synthesis Check',   type: 'formative', date: 'Oct 17', cat: 'BIO.2' },
    { id: 'a6', title: 'Genetics Unit Test',        type: 'summative', date: 'Oct 24', cat: 'BIO.2' },
    { id: 'a7', title: 'Natural Selection Sim',     type: 'formative', date: 'Nov 7',  cat: 'BIO.3' },
    { id: 'a8', title: 'Ecology Field Study',       type: 'summative', date: 'Nov 21', cat: 'BIO.3' },
  ];
  // a gently rising mean with a dip around the hard genetics unit
  const trendMeans = [48, 51, 57, 54, 52, 61, 64, 68];
  const trend = assessments.map((a, i) => ({
    ...a,
    mean: trendMeans[i],
    sd: 16 + Math.round(gauss() * 4),
  }));

  // ── box-and-whisker stats ──────────────────────────────────────────────────
  function boxStats(values) {
    const a = values.filter(v => v != null).sort((x, y) => x - y);
    const n = a.length;
    if (!n) return null;
    const q = p => { const i = (n - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
    const q1 = q(0.25), med = q(0.5), q3 = q(0.75), iqr = q3 - q1;
    const lowF = q1 - 1.5 * iqr, hiF = q3 + 1.5 * iqr;
    const inliers = a.filter(v => v >= lowF && v <= hiF);
    const outliers = a.filter(v => v < lowF || v > hiF);
    const mean = a.reduce((s, v) => s + v, 0) / n;
    return { min: inliers[0], q1, med, q3, max: inliers[inliers.length - 1], outliers, mean: +mean.toFixed(1), n };
  }

  // class mastery-point distribution for one topic (across students)
  function topicPoints(topicId) {
    return students.map(s => { const lv = grid[s.id][topicId]; return lv ? LEVEL_META[lv].pts : null; }).filter(v => v != null);
  }
  function topicBox(topicId) { return boxStats(topicPoints(topicId)); }

  // ── per-assessment raw score distributions (0–100), tied to trend means ─────
  // assessmentScores[assignmentId] = array indexed by student order.
  const assessmentScores = {};
  assessments.forEach((a, ai) => {
    const base = trendMeans[ai];
    assessmentScores[a.id] = students.map(s => {
      const v = base + s.ability * 13 + gauss() * 17;
      return Math.max(2, Math.min(100, Math.round(v)));
    });
  });
  function assessmentBox(aid) { return boxStats(assessmentScores[aid]); }
  function studentAssessmentScore(sid, aid) {
    const idx = students.findIndex(s => s.id === sid);
    return idx >= 0 ? assessmentScores[aid][idx] : null;
  }

  // ── per-student category rollup ─────────────────────────────────────────────
  function studentCategory(sid, catId) {
    const cat = categories.find(c => c.id === catId);
    let n = 0, sum = 0; const counts = { IE: 0, EM: 0, D: 0, EX: 0, ED: 0 };
    cat.topics.forEach(tp => { const lv = grid[sid][`${catId}-${tp.code}`]; if (lv) { n++; sum += LEVEL_META[lv].pts; counts[lv]++; } });
    return { n, avg: n ? sum / n : null, level: n ? pointsToLevel(sum / n) : null, counts };
  }

  // ── synthesized recent feedback / notes per student ─────────────────────────
  function studentFeedback(sid) {
    const st = studentStats(sid);
    const topicsSorted = topics.map(t => ({ t, lv: grid[sid][t.id] })).filter(x => x.lv);
    const weak = topicsSorted.filter(x => LEVEL_META[x.lv].i <= 1).sort((a, b) => LEVEL_META[a.lv].i - LEVEL_META[b.lv].i)[0];
    const strong = topicsSorted.filter(x => LEVEL_META[x.lv].i >= 3).sort((a, b) => LEVEL_META[b.lv].i - LEVEL_META[a.lv].i)[0];
    const out = [];
    if (strong) out.push({ kind: 'strength', topic: strong.t, level: strong.lv, text: `Consistently strong on ${strong.t.title.toLowerCase()} — ready to push toward Exhibiting Depth with an extension task.` });
    if (weak) out.push({ kind: 'focus', topic: weak.t, level: weak.lv, text: `${weak.t.title} is the priority — schedule a reassessment after a targeted reteach.` });
    return out;
  }

  window.PRISM = {
    LEVELS, LEVEL_META, pointsToLevel,
    course, categories, topics,
    students, grid,
    topicStats, topicStatList, studentStats,
    boxStats, topicPoints, topicBox,
    assessmentScores, assessmentBox, studentAssessmentScore,
    studentCategory, studentFeedback,
    classCounts, classAvg, classN,
    assessments, trend,
  };
})();
