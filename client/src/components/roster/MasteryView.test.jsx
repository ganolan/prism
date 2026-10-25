// The Roster tab's Mastery mode (#160): Prism's levels and grade beside Schoology's, and the override.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MasteryView, { LINKED_REASON, mismatchText } from './MasteryView.jsx';
import { PrivateHidden } from '../PrivateDetails.jsx';
import * as api from '../../services/api.js';

vi.mock('../../services/api.js', () => ({
  getProficiencyScale: vi.fn(),
  writeMasteryOverride: vi.fn(),
}));

const LEVELS = [
  { code: 'ED', label: 'Exhibiting Depth', points: 100, gradeScaled: '87.50' },
  { code: 'EX', label: 'Exhibiting', points: 75, gradeScaled: '62.50' },
  { code: 'D', label: 'Developing', points: 50, gradeScaled: '37.50' },
  { code: 'EM', label: 'Emerging', points: 25, gradeScaled: '12.50' },
  { code: 'IE', label: 'Insufficient Evidence', points: 0, gradeScaled: '0.00' },
];

const align = (topic_id, topic_external_id, topic_title, category_id, category_external_id, category_title) => ({
  assignment_schoology_id: 'a1', topic_id, topic_external_id, topic_title, category_id, category_external_id, category_title,
});
const CK = 'AP CS: Content Knowledge';
const CT = 'AP CS: Computational Thinking Practices';
const rollup = (student_uid, objective_id, grade_scaled_rounded, override_value = null) => ({
  student_uid, objective_id, is_category: 1, grade_percentage: null, grade_scaled_rounded, override_value,
});
const MASTERY = {
  categories: [{ id: 'c1', external_id: 'APCS.1', title: CK }, { id: 'c2', external_id: 'APCS.2', title: CT }],
  topics: [
    { id: 't11', category_id: 'c1', external_id: 'APCS.1.1', title: 'General Computer Science Knowledge' },
    { id: 't21', category_id: 'c2', external_id: 'APCS.2.1', title: 'Responsible Solution Design' },
    { id: 't23', category_id: 'c2', external_id: 'APCS.2.3', title: 'Abstraction' },
  ],
  alignments: [
    align('t11', 'APCS.1.1', 'General Computer Science Knowledge', 'c1', 'APCS.1', CK),
    align('t21', 'APCS.2.1', 'Responsible Solution Design', 'c2', 'APCS.2', CT),
    align('t22', 'APCS.2.2', 'Algorithms', 'c2', 'APCS.2', CT),
    align('t23', 'APCS.2.3', 'Abstraction', 'c2', 'APCS.2', CT),
  ],
  scores: [
    // Annie: 1 EX (75); 2 EX (62.5 from 100, 50, 50, 50). Bo: 1 ED, 2 D (50, no 2.3). Cy: 2.3 at 100.
    { student_uid: 'u1', topic_id: 't11', points: 75 },
    { student_uid: 'u1', topic_id: 't21', points: 100 },
    { student_uid: 'u1', topic_id: 't23', points: 50 }, { student_uid: 'u1', topic_id: 't23', points: 50 }, { student_uid: 'u1', topic_id: 't23', points: 50 },
    { student_uid: 'u2', topic_id: 't11', points: 100 },
    { student_uid: 'u2', topic_id: 't21', points: 50 },
    { student_uid: 'u3', topic_id: 't11', points: 75 },
    { student_uid: 'u3', topic_id: 't23', points: 100 },
  ],
  // Annie: Schoology agrees on 1 (EX) and holds an override of D on 2. Bo agrees on both. Cy: 2 differs.
  rollups: [
    rollup('u1', 'c1', 62.5), rollup('u1', 'c2', 87.5, 37.5),
    rollup('u2', 'c1', 87.5), rollup('u2', 'c2', 37.5),
    rollup('u3', 'c1', 62.5), rollup('u3', 'c2', 62.5),
  ],
};
const student = (id, uid, first, last, extra = {}) => ({
  id, schoology_uid: uid, first_name: first, last_name: last, email: `2700${id}@hkis.edu.hk`, grad_year: 2027, ...extra,
});
const STUDENTS = [
  student(1, 'u1', 'Ana', 'Lee', { preferred_name: 'Annie' }),
  student(2, 'u2', 'Bo', 'Ma'),
  student(3, 'u3', 'Cy', 'Ng'),
];

const LOCKED = <PrivateHidden title="Levels and grades are private." />;
function renderView(props = {}) {
  return render(
    <MemoryRouter>
      <MasteryView on locked={LOCKED} mastery={MASTERY} students={STUDENTS} courseId="5" onMasteryChanged={vi.fn()} {...props} />
    </MemoryRouter>,
  );
}
const cardOf = (name) => screen.getByText(name).closest('.mastery-card');
// Hover text is the instant popover (#192), never a native title.
const popOn = (el) => { fireEvent.mouseEnter(el); const text = document.querySelector('.help-pop')?.textContent; fireEvent.mouseLeave(el); return text; };
const chipsOf = (name) => [...cardOf(name).querySelectorAll('.mastery-line .sgc')];

beforeEach(() => {
  vi.clearAllMocks();
  api.getProficiencyScale.mockResolvedValue({ levels: LEVELS, schoologyScaleId: 1 });
  api.writeMasteryOverride.mockResolvedValue({ ok: true });
});

describe('MasteryView', () => {
  it('with Private details off shows only the explanation: no level, grade or chip in the DOM', () => {
    const { container } = renderView({ on: false });
    expect(screen.getByText('Levels and grades are private.')).toBeInTheDocument();
    expect(container.querySelector('.sgc, .mastery-card, .mastery-level')).toBeNull();
    expect(container.textContent).not.toMatch(/\b(EX|ED|B\+)\b/);
    expect(api.getProficiencyScale).not.toHaveBeenCalled();
  });

  it('with no categories says so, and draws no grid', async () => {
    const { container, rerender } = renderView({ mastery: { categories: [], topics: [], scores: [], rollups: [], alignments: [] } });
    expect(await screen.findByText('No mastery data yet. Press Sync Course.')).toBeInTheDocument();
    expect(container.querySelector('.mastery-card, .mastery-head')).toBeNull();
    rerender(<MemoryRouter><MasteryView on locked={LOCKED} mastery={null} students={STUDENTS} courseId="5" /></MemoryRouter>);
    expect(screen.getByText('No mastery data yet. Press Sync Course.')).toBeInTheDocument();
  });

  it('names each category by its short label, "CK - Content Knowledge", and lists the class average first', async () => {
    renderView();
    const cats = await screen.findByRole('group', { name: 'Reporting categories' });
    expect(within(cats).getAllByRole('button').map((b) => b.textContent))
      .toEqual(['All reporting categories', 'CK - Content Knowledge', 'CTP - Computational Thinking Practices']);
    const cards = [...document.querySelectorAll('.mastery-card')];
    expect(cards[0]).toHaveTextContent('Class average');
    expect(cards.slice(1).map((c) => c.querySelector('.mastery-card__name').textContent)).toEqual(['Annie Lee', 'Bo Ma', 'Cy Ng']);
  });

  it("Schoology's chip is faint (sgc) when it agrees and stands out (sgc off) when it differs, with no badge", async () => {
    renderView();
    await screen.findByText('Annie Lee');
    const [agree, differ] = chipsOf('Annie Lee');
    expect(agree.className).toBe('sgc');
    expect(agree).toHaveTextContent(/^EX$/);
    expect(differ.className).toBe('sgc off');
    expect(differ).toHaveTextContent(/^D\*$/); // an override
    expect(differ.textContent).not.toContain('!');
    // A topic not assessed yet is an outlined "-", and the topic chips say what they are.
    const topics = cardOf('Annie Lee').querySelectorAll('.mastery-topic');
    expect([...topics].map((t) => t.textContent)).toEqual(['EX', 'ED', '-', 'D']);
    expect(topics[2]).not.toHaveAttribute('title');
    expect(topics[2]).toHaveAttribute('aria-label', '2.2 Algorithms: not assessed yet');
    expect(popOn(topics[2])).toBe('2.2 Algorithms: not assessed yet');
    expect(popOn(topics[3])).toBe('2.3 Abstraction: Developing (50%)');
  });

  it('each line starts with the category short label (#192), its full name in an instant popover', async () => {
    renderView();
    await screen.findByText('Annie Lee');
    const labels = [...cardOf('Annie Lee').querySelectorAll('.mastery-cat')];
    expect(labels.map((l) => l.textContent)).toEqual(['CK', 'CTP']);
    expect(labels[1]).toHaveAttribute('aria-label', 'Computational Thinking Practices');
    expect(labels[1]).toHaveAttribute('tabindex', '0');
    expect(labels[1]).not.toHaveAttribute('title');
    fireEvent.focus(labels[1]);
    expect(document.querySelector('.help-pop')).toHaveTextContent('Computational Thinking Practices');
    // No number is shown for a category anywhere in the view.
    expect(document.querySelector('.mastery-all').textContent).not.toMatch(/\b[12] - /);
  });

  it('a "-" grade names the categories with no evidence in its popover (#192)', async () => {
    const mastery = { ...MASTERY, scores: [...MASTERY.scores, { student_uid: 'u5', topic_id: 't11', points: 75 }] };
    renderView({ mastery, students: [...STUDENTS, student(4, 'u4', 'Di', 'Oh'), student(5, 'u5', 'Ed', 'Pi')] });
    await screen.findByText('Di Oh');
    const prismOf = (name) => cardOf(name).querySelector('.mastery-grade__prism');
    expect(prismOf('Di Oh')).toHaveTextContent(/^-$/);
    expect(popOn(prismOf('Di Oh'))).toBe('No grade yet: Content Knowledge and Computational Thinking Practices have no evidence. '
      + 'A grade needs evidence in every reporting category.');
    expect(prismOf('Ed Pi')).toHaveAttribute('aria-label', 'No grade yet: Computational Thinking Practices has no evidence. '
      + 'A grade needs evidence in every reporting category.');
    // Nothing on the card itself: no icon, colour or extra line (no Prism grade, so no mismatch either).
    expect(cardOf('Di Oh').querySelector('.mastery-grade').textContent).toBe('-');
  });

  it("the Schoology help is a short list in a wrapped popover, not one long line", async () => {
    renderView();
    await screen.findByText('Annie Lee');
    fireEvent.mouseEnter(document.querySelector('.mastery-head__sgy .help-dot'));
    const pop = document.querySelector('.help-pop');
    expect(pop.querySelectorAll('li')).toHaveLength(3);
    expect(pop).toHaveTextContent(/Highlighted: it differs\. Tap it to set Schoology's override to Prism's level\./);
  });

  it('the help dot sits in the Schoology heading; one grade column, headed Translated grade', async () => {
    renderView();
    await screen.findByText('Annie Lee');
    const head = document.querySelector('.mastery-head');
    const sgy = head.querySelector('.mastery-head__sgy');
    expect(sgy.firstChild.textContent.trim()).toBe('Schoology');
    expect(sgy.querySelector('.help-dot')).toHaveAttribute('aria-label', expect.stringMatching(/^Schoology's level is the one students and report cards see\./));
    expect(within(head).getByText('Translated grade')).toBeInTheDocument();
    expect(within(head).queryByText('Schoology levels')).toBeNull();
    expect(document.querySelector('.mastery-grade .sgc')).toBeNull();
  });

  it("a warning sits on the translated grade when Schoology's levels translate to another grade, with how to correct it", async () => {
    renderView();
    await screen.findByText('Annie Lee');
    const warn = cardOf('Annie Lee').querySelector('.mastery-grade__warn');
    expect(popOn(warn)).toBe("Schoology's levels differ from Prism's. Students see Schoology's levels, so their grade translates to B-, not B+. "
      + "To correct it, override Schoology's level: click a highlighted Schoology level.");
    expect(popOn(cardOf('Annie Lee').querySelector('.mastery-grade__prism'))).toBe("Translated grade from Prism's levels: B+");
    expect(cardOf('Bo Ma').querySelector('.mastery-grade__warn')).toBeNull();
    // The class row has no Schoology levels, so no warning.
    expect(document.querySelector('.mastery-card--class .mastery-grade__warn')).toBeNull();
  });

  it('the warning names the categories Schoology holds no level for, and on a linked section sends the teacher to Schoology', () => {
    expect(mismatchText({ prism: 'B', schoology: null }, ['Producing'], false)).toBe("Schoology's levels differ from Prism's. "
      + "Schoology holds no level for Producing, so students see a blank grade. To correct it, override Schoology's level: click a highlighted Schoology level.");
    expect(mismatchText({ prism: 'B', schoology: 'C' }, [], true)).toMatch(/translates to C, not B\. Prism does not write to Schoology for linked sections\./);
  });

  it('a course with one reporting category has no letter grade, and the grade states why', async () => {
    const one = {
      categories: MASTERY.categories.filter((c) => c.id === 'c1'),
      topics: MASTERY.topics.filter((t) => t.category_id === 'c1'),
      alignments: MASTERY.alignments.slice(0, 1),
      scores: MASTERY.scores.filter((x) => x.topic_id === 't11'),
      rollups: MASTERY.rollups.filter((r) => r.objective_id === 'c1'),
    };
    renderView({ mastery: one });
    await screen.findByText('Annie Lee');
    const why = "No letter grade: HKIS's letter grade chart covers 2 to 5 reporting categories, and this course has 1.";
    const prism = cardOf('Annie Lee').querySelector('.mastery-grade__prism');
    expect(prism).toHaveTextContent('-');
    expect(popOn(prism)).toBe(why);
    expect(cardOf('Annie Lee').querySelector('.mastery-grade__warn')).toBeNull();
  });

  it("tapping a differing chip opens the override with Prism's level first; saving refreshes", async () => {
    const onMasteryChanged = vi.fn();
    renderView({ onMasteryChanged });
    await screen.findByText('Annie Lee');
    fireEvent.click(chipsOf('Annie Lee')[1]);
    expect(screen.getByText(/Annie Lee: CTP - Computational Thinking Practices/)).toBeInTheDocument();
    const first = screen.getAllByRole('button').find((b) => /Override Schoology to/.test(b.textContent));
    expect(first).toHaveTextContent('Override Schoology to EX');
    fireEvent.click(first);
    await waitFor(() => expect(onMasteryChanged).toHaveBeenCalled());
    expect(api.writeMasteryOverride).toHaveBeenCalledWith(5, { studentUid: 'u1', objectiveId: 'c2', level: 'EX' });
  });

  it("the Grade heading's \"?\" shows HKIS's letter grades for the course's number of categories", async () => {
    renderView();
    await screen.findByText('Annie Lee');
    const dot = document.querySelector('.mastery-head__grade .help-dot');
    expect(dot).toHaveAttribute('aria-label', expect.stringMatching(/^HKIS letter grade, 2 reporting categories\. A: 2 ED\. A-: 1 ED, 1 EX\./));
    expect(popOn(dot)).toMatch(/^HKIS letter grade, 2 reporting categories/);
    expect(within(document.querySelector('.mastery-head')).queryByRole('button', { name: 'Scale' })).toBeNull();
    expect(document.querySelector('.mastery-phone-help .help-dot[aria-label^="HKIS letter grade"]')).not.toBeNull();
  });

  it('one category: tapping a heading sorts highest first, lowest first, then off, with Clear sort', async () => {
    renderView();
    await screen.findByText('Annie Lee');
    fireEvent.click(screen.getByRole('button', { name: 'CTP - Computational Thinking Practices' }));
    const order = () => [...document.querySelectorAll('.mastery-row:not(.mastery-row--head):not(.mastery-row--class) .mastery-card__name')]
      .map((n) => n.textContent);
    expect(document.querySelector('.mastery-row:not(.mastery-row--head)')).toHaveTextContent('Class average');
    expect(order()).toEqual(['Annie Lee', 'Bo Ma', 'Cy Ng']);
    expect(screen.getByText('Tap a column heading to sort.')).toBeInTheDocument();

    const abstraction = screen.getByRole('button', { name: /2\.3/ });
    expect(abstraction).toHaveTextContent('2.3Abstraction');
    fireEvent.click(abstraction);
    expect(screen.getByText('Sorted by 2.3 Abstraction, highest first.')).toBeInTheDocument();
    expect(order()).toEqual(['Cy Ng', 'Annie Lee', 'Bo Ma']); // Bo has no 2.3: last
    fireEvent.click(abstraction);
    expect(screen.getByText('Sorted by 2.3 Abstraction, lowest first.')).toBeInTheDocument();
    expect(order()).toEqual(['Annie Lee', 'Cy Ng', 'Bo Ma']);
    fireEvent.click(abstraction);
    expect(screen.getByText('Tap a column heading to sort.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Prism/ }));
    expect(screen.getByText("Sorted by Prism's level, highest first.")).toBeInTheDocument();
    expect(order()).toEqual(['Cy Ng', 'Annie Lee', 'Bo Ma']); // 100, 62.5, 50
    fireEvent.click(screen.getByRole('button', { name: /Clear sort/ }));
    expect(order()).toEqual(['Annie Lee', 'Bo Ma', 'Cy Ng']);
    // The one-category header holds the Schoology heading and its help dot too.
    expect(document.querySelector('.mastery-row--head .mastery-head__sgy .help-dot')).not.toBeNull();
  });

  it('a set of linked sections disables the chip, with the reason Prism refuses the write', async () => {
    renderView({ linked: true });
    await screen.findByText('Annie Lee');
    const differ = chipsOf('Annie Lee')[1];
    expect(differ).toBeDisabled();
    expect(differ).not.toHaveAttribute('title');
    expect(differ).toHaveAttribute('aria-label', `CTP - Computational Thinking Practices, Schoology. ${LINKED_REASON}`);
    expect(screen.getByText(LINKED_REASON)).toBeInTheDocument();
    fireEvent.click(differ);
    expect(screen.queryByText(/Override Schoology/)).not.toBeInTheDocument();
  });
});
