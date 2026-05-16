# Issue #38 — Course gradebook overflows on browser zoom

## Problem

Browser font/page zoom causes the course gradebook to run off the page to the
right. The whole page scrolls horizontally instead of the gradebook table
scrolling within its own card. The Analytics page, by contrast, resizes
correctly at any zoom level.

## Root cause

`.app` is a flex container (`display: flex`). Its content area, `.content`,
is the single in-flow flex child with `flex: 1` and no `min-width` (the
sidebar is `position: fixed`, out of flow).

Flex items default to `min-width: auto`, which resolves to the intrinsic
minimum width of their content — they refuse to shrink below it. The
gradebook table (`GradebookView` in `client/src/pages/CoursePage.jsx`) renders
many `<th>` cells with `min-width: 80px` and `white-space: nowrap`, giving the
table a large intrinsic minimum width.

When the viewport (in CSS pixels) shrinks below that width — which is what
browser zoom does — `.content` refuses to shrink, so the whole page overflows
to the right. The `overflowX: 'auto'` already set on the gradebook card never
engages, because the card is sized by `.content`, which itself never gets
narrower than the table.

The Analytics page is unaffected because it uses recharts
`ResponsiveContainer width="100%"`, which measures its parent and imposes no
large intrinsic minimum width.

## The fix

Add `min-width: 0` to the `.content` rule in `client/src/app.css`:

```css
.content {
  flex: 1;
  min-width: 0;        /* allow flex item to shrink below content's intrinsic width */
  margin-left: 240px;
  padding: 2rem 2.5rem;
  max-width: 1280px;
}
```

Once `.content` can shrink, the gradebook card (a block element, sized by
`.content`) is constrained to the viewport, and its existing
`overflowX: 'auto'` engages — the wide table scrolls inside its card instead
of pushing the page. The sticky "Student" column continues to work, since
sticky positioning resolves against the card's scroll container.

## Scope

The fix is applied globally to `.content`, not scoped to the gradebook:

- Page-level horizontal scroll is never the desired behavior; wide content
  should scroll within its own container.
- It protects any other current or future wide table the same way.

No component changes are needed. No other page regresses: every other page's
content already fits or wraps, so allowing `.content` to shrink changes
nothing for them.

## Verification

Manual (a CSS layout bug cannot be caught by jsdom-based unit tests):

1. Open a course → Gradebook tab.
2. Browser-zoom to ~150%. Confirm the page itself does not scroll right and
   the table scrolls within its card.
3. Spot-check Dashboard, Roster, and Analytics at the same zoom to confirm
   nothing is squished or clipped.

## Out of scope

- Automated regression coverage (would require a new Playwright e2e harness
  with a running server and seeded data — disproportionate for a one-line
  CSS fix).
- Any redesign of the gradebook table layout.
