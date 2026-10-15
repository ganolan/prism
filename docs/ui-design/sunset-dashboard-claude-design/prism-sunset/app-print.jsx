/* ============================================================================
   PRISM · Sunset — PRINT composition
   Stacks the key views into a static, paged document for PDF export.
   ============================================================================ */
const { useState } = React;
const noop = () => {};

function PrintHeader() {
  const D = window.PRISM;
  return (
    <div className="pr-cover">
      <div className="pr-cover-brand">
        <PrismMark size={40} />
        <div>
          <div className="pr-cover-name">Prism</div>
          <div className="pr-cover-tag">Standards-Based Mastery Report</div>
        </div>
      </div>
      <div className="pr-cover-meta">
        <div><span>Course</span><b>{D.course.name} · {D.course.section}</b></div>
        <div><span>Term</span><b>{D.course.term}</b></div>
        <div><span>Students</span><b>{D.students.length}</b></div>
        <div><span>Standards</span><b>{D.topics.length} across {D.categories.length} categories</b></div>
        <div><span>Generated</span><b>{new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</b></div>
      </div>
    </div>
  );
}

function Section({ n, title, sub, children, breakBefore }) {
  return (
    <section className={'pr-section' + (breakBefore ? ' pr-break' : '')}>
      <div className="pr-sec-head">
        <span className="pr-sec-n mono">{n}</span>
        <div>
          <h2 className="pr-sec-title">{title}</h2>
          {sub && <p className="pr-sec-sub">{sub}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function PrintDoc() {
  return (
    <div className="pr-doc">
      <PrintHeader />

      <Section n="01" title="Class overview" sub="At-a-glance mastery for the section this term.">
        <StatStrip />
        <div className="pr-grid-2">
          <ClassDistribution />
          <TrendChart />
        </div>
      </Section>

      <Section n="02" title="Mastery heatmap" sub="Every student against every measurement topic." breakBefore>
        <MasteryMatrix picked={null} setPicked={noop} openStudent={noop} />
      </Section>

      <Section n="03" title="Standard mastery breakdown" sub="Where the class is strong and weak, ranked." breakBefore>
        <StandardBreakdown picked={null} onPick={noop} />
      </Section>

      <Section n="04" title="Proficiency by standard" sub="Discrete proficiency distribution, anchored at the threshold." breakBefore>
        <DivergingBars />
      </Section>

      <Section n="05" title="Evidence → proficiency" sub="How continuous assessment scores discretize through the rubric." breakBefore>
        <ScoreToProficiency />
      </Section>

      <div className="pr-foot">Prism · {window.PRISM.course.name} — {window.PRISM.course.term} · Confidential student data</div>
    </div>
  );
}

document.documentElement.setAttribute('data-theme', 'twilight');
document.documentElement.setAttribute('data-mastery', 'sunset');
document.documentElement.setAttribute('data-density', 'regular');
ReactDOM.createRoot(document.getElementById('root')).render(<PrintDoc />);

/* auto-print once fonts + JSX are ready */
(async function () {
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
  setTimeout(() => { window.print(); }, 900);
})();
