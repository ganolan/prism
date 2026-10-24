// The Roster tab's Mastery mode (#160): Prism's levels and grade beside Schoology's, and the override.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MasteryView, { LINKED_REASON } from './MasteryView.jsx';
import { LockedBox } from './RosterTab.jsx';
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

const LOCKED = <LockedBox title="Levels and grades are private." />;
function renderView(props = {}) {
  return render(
    <MemoryRouter>
      <MasteryView on locked={LOCKED} mastery={MASTERY} students={STUDENTS} courseId="5" onMasteryChanged={vi.fn()} {...props} />
    </MemoryRouter>,
  );
}
const cardOf = (name) => screen.getByText(name).closest('.mastery-card');
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

  it('names each category "1 - Content Knowledge" and lists the class average first', async () => {
    renderView();
    const cats = await screen.findByRole('group', { name: 'Reporting categories' });
    expect(within(cats).getAllByRole('button').map((b) => b.textContent))
      .toEqual(['All reporting categories', '1 - Content Knowledge', '2 - Computational Thinking Practices']);
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
    expect(topics[2]).toHaveAttribute('title', '2.2 Algorithms: not assessed yet');
    expect(topics[3]).toHaveAttribute('title', '2.3 Abstraction: Developing (50%)');
  });

  it('the help dot sits in the Schoology heading, and the grade headings read Grade and Schoology levels', async () => {
    renderView();
    await screen.findByText('Annie Lee');
    const head = document.querySelector('.mastery-head');
    const sgy = head.querySelector('.mastery-head__sgy');
    expect(sgy.firstChild.textContent.trim()).toBe('Schoology');
    expect(sgy.querySelector('.help-dot')).toHaveAttribute('aria-label', expect.stringMatching(/^Schoology's level is the one students and report cards see\./));
    expect(within(head).getByText('Grade')).toBeInTheDocument();
    expect(within(head).getByText('Schoology levels')).toBeInTheDocument();
  });

  it("the grade's Schoology chip states both grades when they differ", async () => {
    renderView();
    await screen.findByText('Annie Lee');
    const annie = cardOf('Annie Lee').querySelector('.mastery-grade .sgc');
    expect(annie).toHaveClass('off');
    expect(annie).toHaveAttribute('title', "Schoology's levels give B; Prism's give B+");
    const bo = cardOf('Bo Ma').querySelector('.mastery-grade .sgc');
    expect(bo.className).toBe('sgc sgc--grade');
    expect(bo).toHaveAttribute('title', "Schoology's levels give the same grade");
  });

  it("tapping a differing chip opens the override with Prism's level first; saving refreshes", async () => {
    const onMasteryChanged = vi.fn();
    renderView({ onMasteryChanged });
    await screen.findByText('Annie Lee');
    fireEvent.click(chipsOf('Annie Lee')[1]);
    expect(screen.getByText(/Annie Lee: 2 - Computational Thinking Practices/)).toBeInTheDocument();
    const first = screen.getAllByRole('button').find((b) => /Override Schoology to/.test(b.textContent));
    expect(first).toHaveTextContent('Override Schoology to EX');
    fireEvent.click(first);
    await waitFor(() => expect(onMasteryChanged).toHaveBeenCalled());
    expect(api.writeMasteryOverride).toHaveBeenCalledWith(5, { studentUid: 'u1', objectiveId: 'c2', level: 'EX' });
  });

  it('opens the letter grade scale from the Scale link by the Grade header', async () => {
    renderView();
    await screen.findByText('Annie Lee');
    fireEvent.click(within(document.querySelector('.mastery-head')).getByRole('button', { name: 'Scale' }));
    expect(screen.getByText('HKIS Letter Grade Translation Scale')).toBeInTheDocument();
  });

  it('one category: tapping a heading sorts highest first, lowest first, then off, with Clear sort', async () => {
    renderView();
    await screen.findByText('Annie Lee');
    fireEvent.click(screen.getByRole('button', { name: '2 - Computational Thinking Practices' }));
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
    expect(differ).toHaveAttribute('title', LINKED_REASON);
    expect(screen.getByText(LINKED_REASON)).toBeInTheDocument();
    fireEvent.click(differ);
    expect(screen.queryByText(/Override Schoology/)).not.toBeInTheDocument();
  });
});
