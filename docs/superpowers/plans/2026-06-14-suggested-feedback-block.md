# Suggested Feedback Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the teacher-facing dot-point Strengths/Suggestions analysis (lost from recent grading runs) by reliably emitting it from the assessment-grader plugin and surfacing it on the `/assessment/` page inside a consolidated "Suggested feedback" block.

**Architecture:** Frontend-only change in Prism plus prose-only changes in the assessment-grader plugin. No DB schema, MCP-tool, API, or service change — `feedback_json.strengths`/`.suggestions` already flow MCP → DB → `feedback_parsed`. The Prism work consolidates the existing top-of-card reviewer-flags strip and the bottom suggested-feedback box into one block placed between the rubric grid and the Overall Comment, with an expandable Strengths/Suggestions region.

**Tech Stack:** React (Vite), Vitest + React Testing Library (client tests run from `client/`), Markdown prompt docs (assessment-grader, no test harness).

**Spec:** `docs/superpowers/specs/2026-06-14-suggested-feedback-block-design.md`

**Repos:**
- Prism (this repo): `/Users/gnolan/Library/CloudStorage/OneDrive-HongKongInternationalSchool/_repos/prism` — branch `feat/suggested-feedback-block`.
- assessment-grader: `/Users/gnolan/Library/CloudStorage/OneDrive-HongKongInternationalSchool/_repos/assessment-grader` — separate git repo; its tasks commit there.

---

## File Structure

- `client/src/pages/AssessmentSummaryPage.jsx` — `StudentRubricCard`: add reads + `showFullAnalysis` state; remove the top reviewer-flags `<details>` strip, the control-band "Use suggestion" button, and the bottom suggested-feedback box; insert one consolidated block between the rubric grid and the Overall Comment.
- `client/src/pages/AssessmentSummaryPage.test.jsx` — rewrite the now-obsolete collapsed-flags test; add a describe block for the consolidated block.
- `docs/design-language.md` — append the UI decision.
- `assessment-grader/shared/orchestration.md` — require `strengths`/`suggestions` in the Prism write step.
- `assessment-grader/shared/output-format.md` — define the teacher-facing analysis fields.
- `assessment-grader/shared/grading-philosophy.md` — scope the "don't enumerate a checklist" rule to the student-facing narrative.

---

## Task 1: Consolidated Suggested Feedback block (Prism frontend)

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx`
- Test: `client/src/pages/AssessmentSummaryPage.test.jsx`

- [ ] **Step 1: Rewrite the obsolete collapsed-flags test**

In `client/src/pages/AssessmentSummaryPage.test.jsx`, inside `describe('StudentRubricCard — card chrome (Slice 5)' ...)`, replace this test:

```jsx
  it('renders the reviewer-flags strip, collapsed by default, when reviewer_flags is present', () => {
    renderCard(withFeedback({ reviewer_flags: 'No prototype link pasted.' }));
    const summary = screen.getByText(/Reviewer flags/);
    expect(summary).toBeInTheDocument();
    const details = summary.closest('details');
    expect(details).not.toHaveAttribute('open'); // collapsed by default
    expect(details).toHaveTextContent('No prototype link pasted.');
  });
```

with:

```jsx
  it('renders reviewer flags uncollapsed (no <details>) when reviewer_flags is present', () => {
    renderCard(withFeedback({ reviewer_flags: 'No prototype link pasted.' }));
    expect(screen.getByText(/Reviewer flags/)).toBeInTheDocument();
    // Flags are shown expanded now — visible text, not hidden behind a closed <details>.
    expect(screen.getByText('No prototype link pasted.')).toBeInTheDocument();
    expect(document.querySelector('details')).toBeNull();
  });
```

- [ ] **Step 2: Add the consolidated-block test suite**

Append this describe block at the END of `client/src/pages/AssessmentSummaryPage.test.jsx`:

```jsx
describe('StudentRubricCard — consolidated Suggested Feedback block', () => {
  const withFb = (parsed) => ({ feedbackRow: { feedback_parsed: parsed } });

  it('shows reviewer flags uncollapsed alongside the narrative, with no <details>', () => {
    renderCard(withFb({ reviewer_flags: 'Check the CAD deliverable.', narrative_feedback: 'Great work, Ada!' }));
    expect(screen.getByText('Check the CAD deliverable.')).toBeInTheDocument();
    expect(screen.getByText('Great work, Ada!')).toBeInTheDocument();
    expect(document.querySelector('details')).toBeNull();
  });

  it('renders the block (with flags) even when there is no narrative, and shows no Use suggestion', () => {
    renderCard(withFb({ reviewer_flags: 'Flag only.' }));
    expect(screen.getByText('Suggested feedback')).toBeInTheDocument();
    expect(screen.getByText('Flag only.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /use suggestion/i })).not.toBeInTheDocument();
  });

  it('hides strengths/suggestions by default and reveals them via Show full analysis', () => {
    renderCard(withFb({
      narrative_feedback: 'Nice!',
      strengths: ['Strong calendar feature'],
      suggestions: ['Add an edit flow'],
    }));
    expect(screen.queryByText('Strong calendar feature')).not.toBeInTheDocument();
    expect(screen.queryByText('Add an edit flow')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show full analysis/i }));
    expect(screen.getByText('Strengths')).toBeInTheDocument();
    expect(screen.getByText('Suggestions')).toBeInTheDocument();
    expect(screen.getByText('Strong calendar feature')).toBeInTheDocument();
    expect(screen.getByText('Add an edit flow')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /hide full analysis/i }));
    expect(screen.queryByText('Strong calendar feature')).not.toBeInTheDocument();
  });

  it('orders flags → analysis → narrative when expanded', () => {
    renderCard(withFb({
      reviewer_flags: 'FLAGTEXT',
      narrative_feedback: 'NARRATIVETEXT',
      strengths: ['STRENGTHTEXT'],
    }));
    fireEvent.click(screen.getByRole('button', { name: /show full analysis/i }));
    const html = document.body.innerHTML;
    expect(html.indexOf('FLAGTEXT')).toBeLessThan(html.indexOf('STRENGTHTEXT'));
    expect(html.indexOf('STRENGTHTEXT')).toBeLessThan(html.indexOf('NARRATIVETEXT'));
  });

  it('omits the Show full analysis button when strengths and suggestions are both empty', () => {
    renderCard(withFb({ narrative_feedback: 'Nice!', strengths: [], suggestions: [] }));
    expect(screen.queryByRole('button', { name: /full analysis/i })).not.toBeInTheDocument();
  });

  it('shows the Show full analysis button when only suggestions are present', () => {
    renderCard(withFb({ narrative_feedback: 'Nice!', suggestions: ['Add tests'] }));
    expect(screen.getByRole('button', { name: /show full analysis/i })).toBeInTheDocument();
  });

  it('keeps Use suggestion in the block footer and copies the narrative into the comment', () => {
    renderCard(withFb({ narrative_feedback: 'Excellent, Ada!' }));
    fireEvent.click(screen.getByRole('button', { name: /use suggestion/i }));
    expect(screen.getByPlaceholderText(/Teacher comment/i)).toHaveValue('Excellent, Ada!');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: FAIL — new tests can't find "Show full analysis" / strengths text; the rewritten flags test fails because a `<details>` still exists.

- [ ] **Step 4: Add reads + state**

In `client/src/pages/AssessmentSummaryPage.jsx`, replace:

```jsx
  const reviewerFlags = feedbackRow?.feedback_parsed?.reviewer_flags || null;
  const narrativeSuggestion = feedbackRow?.feedback_parsed?.narrative_feedback || null;
```

with:

```jsx
  const reviewerFlags = feedbackRow?.feedback_parsed?.reviewer_flags || null;
  const narrativeSuggestion = feedbackRow?.feedback_parsed?.narrative_feedback || null;
  // Teacher-facing dot-point analysis (grader signal; never published to the
  // student). Lives in feedback_json.strengths/.suggestions, distinct from the
  // narrative and the reviewer flags. Surfaced via the "Show full analysis" toggle.
  const strengths = feedbackRow?.feedback_parsed?.strengths || [];
  const suggestions = feedbackRow?.feedback_parsed?.suggestions || [];
  const hasAnalysis = strengths.length > 0 || suggestions.length > 0;
  const hasSuggestionBlock = Boolean(narrativeSuggestion || reviewerFlags || hasAnalysis);
  const [showFullAnalysis, setShowFullAnalysis] = useState(false);
```

- [ ] **Step 5: Remove the top reviewer-flags `<details>` strip**

In `client/src/pages/AssessmentSummaryPage.jsx`, delete this block (replace with an empty string):

```jsx
      {/* Reviewer flags strip — collapsed by default */}
      {reviewerFlags && (
        <details style={{
          border: '1px solid #e6c98a', background: '#fffbef', borderRadius: 7,
          margin: '0.75rem 1rem 0',
        }}>
          <summary style={{
            cursor: 'pointer', listStyle: 'none', padding: '0.45rem 0.7rem',
            fontSize: '0.72rem', fontWeight: 600, color: '#92740f',
            display: 'flex', alignItems: 'center', gap: '0.45rem',
          }}>
            ⚑ Reviewer flags
          </summary>
          <div style={{ padding: '0 0.7rem 0.6rem', fontSize: '0.72rem', lineHeight: 1.5, color: '#5a4a1f' }}>
            {reviewerFlags}
          </div>
        </details>
      )}

```

- [ ] **Step 6: Remove the control-band "Use suggestion" button**

In `client/src/pages/AssessmentSummaryPage.jsx`, delete this block (it sits inside the control band, after the pending-count badge — replace with an empty string):

```jsx
          {narrativeSuggestion && (
            <button
              onClick={() => applyComment(normalizePastedText(narrativeSuggestion))}
              title="Copy the suggestion up into your comment"
              style={{
                borderRadius: 7, padding: '0.4rem 0.75rem', fontSize: '0.74rem',
                fontWeight: 600, cursor: 'pointer',
                background: 'var(--ai-suggest-wash)', color: 'var(--ai-suggest)', border: '1px solid var(--ai-suggest)',
              }}
            >
              ↑ Use suggestion
            </button>
          )}
```

- [ ] **Step 7: Remove the bottom suggested-feedback box**

In `client/src/pages/AssessmentSummaryPage.jsx`, delete this block (replace with an empty string):

```jsx
        {narrativeSuggestion && (
          <div style={{
            marginTop: '0.55rem', border: '1px solid #e6e1f3', background: '#faf9fd',
            borderRadius: 7, padding: '0.5rem 0.65rem',
          }}>
            <div style={{
              fontSize: '0.63rem', fontWeight: 600, color: '#9a90b8',
              letterSpacing: '0.03em', marginBottom: '0.28rem',
              display: 'flex', alignItems: 'center', gap: '0.3rem',
            }}>
              <AiSparkle size={12} style={{ color: 'var(--ai-suggest)' }} /> Suggested feedback
            </div>
            <div style={{ fontSize: '0.72rem', lineHeight: 1.4, color: '#716b85', whiteSpace: 'pre-wrap' }}>
              {narrativeSuggestion}
            </div>
          </div>
        )}
```

- [ ] **Step 8: Insert the consolidated block before the Overall Comment**

In `client/src/pages/AssessmentSummaryPage.jsx`, replace:

```jsx
      {/* Overall Comment — the hero */}
```

with (note: the new block is a 6-space-indented sibling of the rubric grid div and the Overall Comment div):

```jsx
      {/* Consolidated AI suggestion block: reviewer flags (uncollapsed) →
          expandable Strengths/Suggestions analysis → narrative → footer actions.
          Placed between the rubric grid and the Overall Comment. */}
      {hasSuggestionBlock && (
        <div style={{
          margin: '0.75rem 1rem 0', border: '1px solid #e6e1f3', background: '#faf9fd',
          borderRadius: 7, padding: '0.5rem 0.65rem',
        }}>
          <div style={{
            fontSize: '0.63rem', fontWeight: 600, color: '#9a90b8',
            letterSpacing: '0.03em', marginBottom: '0.4rem',
            display: 'flex', alignItems: 'center', gap: '0.3rem',
          }}>
            <AiSparkle size={12} style={{ color: 'var(--ai-suggest)' }} /> Suggested feedback
          </div>

          {reviewerFlags && (
            <div style={{
              border: '1px solid #e6c98a', background: '#fffbef', borderRadius: 7,
              padding: '0.45rem 0.6rem', marginBottom: '0.5rem',
            }}>
              <div style={{
                fontSize: '0.72rem', fontWeight: 600, color: '#92740f',
                display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.25rem',
              }}>
                ⚑ Reviewer flags
              </div>
              <div style={{ fontSize: '0.72rem', lineHeight: 1.5, color: '#5a4a1f', whiteSpace: 'pre-wrap' }}>
                {reviewerFlags}
              </div>
            </div>
          )}

          {showFullAnalysis && hasAnalysis && (
            <div style={{ marginBottom: '0.5rem' }}>
              {strengths.length > 0 && (
                <div style={{ marginBottom: suggestions.length > 0 ? '0.4rem' : 0 }}>
                  <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#716b85', marginBottom: '0.2rem' }}>
                    Strengths
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.72rem', lineHeight: 1.45, color: '#716b85' }}>
                    {strengths.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </div>
              )}
              {suggestions.length > 0 && (
                <div>
                  <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#716b85', marginBottom: '0.2rem' }}>
                    Suggestions
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.72rem', lineHeight: 1.45, color: '#716b85' }}>
                    {suggestions.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}

          {narrativeSuggestion && (
            <div style={{ fontSize: '0.72rem', lineHeight: 1.4, color: '#716b85', whiteSpace: 'pre-wrap' }}>
              {narrativeSuggestion}
            </div>
          )}

          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
            gap: '0.5rem', marginTop: '0.55rem',
          }}>
            {hasAnalysis && (
              <button
                type="button"
                onClick={() => setShowFullAnalysis(v => !v)}
                style={{
                  borderRadius: 7, padding: '0.35rem 0.6rem', fontSize: '0.72rem',
                  fontWeight: 600, cursor: 'pointer',
                  background: 'var(--card-bg)', color: 'var(--text-muted)', border: '1px solid var(--border)',
                }}
              >
                {showFullAnalysis ? '▴ Hide full analysis' : '▾ Show full analysis'}
              </button>
            )}
            {narrativeSuggestion && (
              <button
                onClick={() => applyComment(normalizePastedText(narrativeSuggestion))}
                title="Copy the suggestion down into your comment"
                style={{
                  borderRadius: 7, padding: '0.4rem 0.75rem', fontSize: '0.74rem',
                  fontWeight: 600, cursor: 'pointer',
                  background: 'var(--ai-suggest-wash)', color: 'var(--ai-suggest)', border: '1px solid var(--ai-suggest)',
                }}
              >
                ↓ Use suggestion
              </button>
            )}
          </div>
        </div>
      )}

      {/* Overall Comment — the hero */}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd client && npx vitest run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS — all consolidated-block tests green, rewritten flags test green, and the pre-existing Slice 5 / Slice 4 suggestion tests still green.

- [ ] **Step 10: Commit**

```bash
cd "/Users/gnolan/Library/CloudStorage/OneDrive-HongKongInternationalSchool/_repos/prism"
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat: consolidated Suggested Feedback block with expandable analysis

Render strengths/suggestions (teacher-facing) behind a Show full analysis
toggle; move reviewer flags inline+uncollapsed and Use suggestion into the
block footer between the rubric and the Overall Comment. Frontend only — data
already flows via feedback_json.strengths/.suggestions.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Append the UI decision to the design-language doc (Prism)

**Files:**
- Modify: `docs/design-language.md`

- [ ] **Step 1: Append the entry**

Add this section at the END of `docs/design-language.md`:

```markdown
## Suggested Feedback block — consolidated AI suggestion (June 2026, branch `feat/suggested-feedback-block`)

The `/assessment/` card's AI output is one block between the rubric grid and the
Overall Comment, titled "Suggested feedback" (violet `AiSparkle` accent). It
replaces two earlier, separated pieces: the collapsed reviewer-flags `<details>`
strip at the top of the card and the read-only narrative box at the bottom.

- **Flags inline and uncollapsed.** Reviewer flags (when present) render expanded
  at the top of the block, above the narrative — QA signal the teacher should see
  without a click. The old top-of-card collapsed `<details>` is gone.
- **Teacher-facing analysis is opt-in detail.** `strengths`/`suggestions`
  (`feedback_json`, distinct from `reviewer_flags` and `narrative_feedback`) render
  as plain dot-point lists *between the flags and the narrative*, hidden by default
  behind a `▾ Show full analysis` footer toggle. The toggle is omitted entirely
  when both arrays are empty — no affordance that reveals nothing.
- **Actions live in the block footer, right-aligned.** `▾ Show full analysis` and
  `↓ Use suggestion` sit in the footer. "Use suggestion" copies the narrative
  *down* into the Overall Comment below it (hence the down arrow — source above,
  destination below), unchanged in behaviour from its former control-band spot.
- **Block visibility:** rendered when any of narrative / flags / strengths /
  suggestions is present, so a flags-only row still shows its flags now that they
  no longer have an independent top-of-card home.
```

- [ ] **Step 2: Commit**

```bash
git add docs/design-language.md
git commit -m "docs(design-language): consolidated Suggested Feedback block

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Reliable emission in the assessment-grader plugin (separate repo)

**Repo/cwd:** `/Users/gnolan/Library/CloudStorage/OneDrive-HongKongInternationalSchool/_repos/assessment-grader`
**Files:** `shared/orchestration.md`, `shared/output-format.md`, `shared/grading-philosophy.md`
**Note:** prose-only plugin, no automated test harness. Verification = the wording is correct and a future grading run populates `strengths`/`suggestions` (a re-grade shows non-empty arrays in `feedback_json`).

- [ ] **Step 1: Require strengths/suggestions in the Prism write step**

In `shared/orchestration.md`, replace:

```
Call `prism` `write_student_suggestions` (one batched call for the class) with, per student:
`narrative_feedback`, `rubric_scores` (`{topic external_id|title: level}`, omit a row for `[PENDING]`),
`reviewer_flags` (string|null; append `[PENDING]` actions here), optional `strengths`/`suggestions`/
`score`. Then `write_assessment_analysis` (`noticings[]` + optional `moderation_note`). These upsert
```

with:

```
Call `prism` `write_student_suggestions` (one batched call for the class) with, per student:
`narrative_feedback`, `rubric_scores` (`{topic external_id|title: level}`, omit a row for `[PENDING]`),
`reviewer_flags` (string|null; append `[PENDING]` actions here), **`strengths` and `suggestions`
(required — 2-4 concise bullets each; teacher-facing analysis, see "Teacher-facing analysis" in
`output-format.md`)**, optional `score`. Then `write_assessment_analysis` (`noticings[]` + optional
`moderation_note`). These upsert
```

- [ ] **Step 2: Define the teacher-facing analysis fields**

In `shared/output-format.md`, find the per-student format fenced block that ends with:

```
**Feedback:**

[2-4 sentences following the feedback philosophy in grading-philosophy.md]
```
```

Immediately after that fenced block's closing ` ``` ` (i.e. before the line beginning "**Include the shortened measurement topic name…**"), insert:

```markdown
**Teacher-facing analysis (`strengths` / `suggestions`) — required in the Prism write.** In
addition to the student-facing Feedback paragraph, produce for every student two short dot-point
lists and pass them to `write_student_suggestions`: `strengths` (2-4 bullets naming what the work
does well) and `suggestions` (2-4 bullets naming concrete next moves). These are **grader signal
for the teacher, never shown to the student** and never published to Schoology, so they are
distinct from the narrative comment and from `reviewer_flags`. Keep each bullet to one concise
line. Unlike the student narrative, this list may be a structured enumeration — the "don't
enumerate a checklist" rule in `grading-philosophy.md` governs the *student-facing narrative*, not
this teacher-facing analysis.
```

- [ ] **Step 3: Scope the "don't enumerate a checklist" rule to the narrative**

In `shared/grading-philosophy.md`, find the paragraph that ends with:

```
Generalizing also fails safe, because a general direction cannot be factually wrong the way "you left out a driver-practice idea" can be when the item was actually there.
```

Append to the end of that same paragraph (same line):

```
 (This rule governs the *student-facing* narrative comment. The separate teacher-facing `strengths`/`suggestions` lists written to Prism — see `output-format.md` — are explicitly allowed to be a short structured enumeration, because they are grader signal, not student feedback.)
```

- [ ] **Step 4: Commit (in the assessment-grader repo)**

```bash
cd "/Users/gnolan/Library/CloudStorage/OneDrive-HongKongInternationalSchool/_repos/assessment-grader"
git add shared/orchestration.md shared/output-format.md shared/grading-philosophy.md
git commit -m "feat(grading): require teacher-facing strengths/suggestions in Prism write

These dot-point lists are grader signal (distinct from the student narrative and
reviewer flags). Previously listed as optional, so emission was incidental and a
recent run wrote empty arrays. Scope the 'don't enumerate a checklist' rule to
the student-facing narrative only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Restore emission (require strengths/suggestions) → Task 3. ✓
- Persist in existing `feedback_json.strengths`/`.suggestions` (no schema/MCP change) → no task needed; verified already wired (reads added in Task 1 Step 4). ✓
- Layout: flags uncollapsed → strengths/suggestions (expanded only) → narrative → footer with Show full analysis + ↓ Use suggestion, between rubric and Overall Comment → Task 1 Step 8. ✓
- "Use suggestion" moves to footer with a down arrow → Task 1 Steps 6 + 8. ✓
- Show full analysis hidden by default; omitted when both arrays empty → Task 1 Step 8 (`hasAnalysis` gates the button; `showFullAnalysis` defaults false). ✓
- Block-visibility for flags-only rows → `hasSuggestionBlock` (Task 1 Step 4 + tests). ✓
- Tests (flags uncollapsed, reveal toggle, empty-state, footer Use suggestion, ROB-style empty arrays) → Task 1 Steps 1-2. ✓
- Design-language append → Task 2. ✓
- Out of scope (no schema/MCP/service change, no ROB backfill, FeedbackPage untouched, `getAssessmentContext` read-back untouched) → respected; no tasks touch them. ✓

**2. Placeholder scan:** No TBD/TODO; every code/step has concrete content and exact commands. ✓

**3. Type/name consistency:** `strengths`, `suggestions`, `hasAnalysis`, `hasSuggestionBlock`, `showFullAnalysis`/`setShowFullAnalysis` are defined in Task 1 Step 4 and used identically in Step 8. Button accessible names (`/show full analysis/i`, `/hide full analysis/i`, `/use suggestion/i`) match the rendered text in Step 8. The block title text "Suggested feedback" matches the assertions in tests and the pre-existing Slice 5 test. ✓
