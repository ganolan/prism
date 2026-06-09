# Rubric content-dedup + agent attach (#110)

> Status: approved design (2026-06-09). Follows the rubric-binding-and-mcp work
> merged in `9ae4d11`. Sibling polish (#109 one-step reassign, #112 rename)
> shipped in `55c25ba`. The fuzzy near-match diff dialog is the separate
> follow-up #111 and is explicitly **out of scope** here.

## 1. Problem & intent

A teacher — or the MCP agent acting for them — can create a content-identical
**duplicate** of a rubric that already exists. e.g. *"upload the design rubric for
the MAD weather app"* when an identical **Design** rubric already exists (attached
to the Personal Data App project). Today:

- MCP `write_rubric` dedups **only by name** (`upsertRubricByName`) — a
  differently-named but identical rubric is undetected, and a same-named but
  *different* rubric is **silently overwritten** (the dangerous case).
- The CSV-upload path (`uploadRubricCsv` → `saveRubric` with no id) **always
  creates a new row**, even for identical content.
- There is **no content-based detection** anywhere.

The data model already supports the right outcome: `rubric_attachments` is
many-assignments→one-rubric, so the same **Design** rubric should be
**reused** across projects, not copied.

### Goals
- Detect an **exact content match** on create/upload/write and **reuse** the
  existing rubric instead of duplicating — reported explicitly.
- Stop `write_rubric` from silently overwriting a same-named-but-different rubric;
  instead surface a conflict so the agent asks the teacher *"new rubric, or update
  the existing one?"*
- Give the agent the ability to **attach** a (reused or new) rubric to an
  assignment, so the end-to-end "set up rubric X for assignment Y" flow works.

### Non-goals (→ #111)
- Fuzzy / near-match detection, diff display, and the in-modal "Update existing vs
  Save as new" confirmation **dialog**. #111 owns that dialog; building a throwaway
  version here is explicitly avoided.
- A combined write+attach MCP tool (we use two composable tools — see §5).
- Attaching via the CSV path is unchanged (that screen already attaches after
  upload).

## 2. Decisions (settled in brainstorm, 2026-06-09)

| # | Decision |
|---|---|
| Q1 | **Exact-content reuse ships on both surfaces** (MCP + CSV). The same-name-different-content **prompt** is handled *now* on the MCP path (agent-driven); the in-modal CSV dialog is deferred to #111. CSV upload stays non-destructive create-new on a name collision. |
| Q2 | The agent gains an **`attach_rubric`** tool (separate from `write_rubric`, mirroring the server's library-vs-binding split). `write_rubric` stays library-only. On a duplicate **name** with different content, `write_rubric` **prompts** (returns a conflict) rather than overwriting. |
| Q3 | The content fingerprint is **computed on read** — no stored column, no migration, no staleness. A teacher's library is tens of rubrics; cost is negligible. |
| Rationale | Rubric **master copies live outside Prism** (the teacher's own files), so an *update* (with confirmation) is low-risk — the design favours reuse/update over defensive blocking. |

### Resulting matrix (write_rubric)
| Incoming vs existing | Action |
|---|---|
| Exact content match (any name) | Reuse existing, no copy; report `match: "exact"` |
| Same name + identical content | Same rubric — reuse, no-op (a special case of the row above) |
| Same name + **different** content | **Prompt**: return `{ conflict: "name", … }`; agent re-calls with `on_name_conflict: "update"` (replace) or `"new"` (separate copy) |
| Different name + different content | Create new (normal) |

## 3. Content fingerprint — `server/services/rubricHash.js` (new)

`hashRubricContent(content)` → a `sha256` hex digest over the rubric's **content
only**, normalized so trivial differences don't change identity.

- **Input shape** (what both the stored `getRubric()` output and incoming
  write/upload content already have):
  `{ criteria: [ { criterion_name, standard_title, reporting_category,
  descriptors: { ED, EX, D, EM, IE } } ] }`.
- **Canonicalization** (a pure helper, stable JSON then `sha256`):
  - criteria in `position` order (array order for incoming content);
  - per criterion, a fixed key order: `criterion_name`, `standard_title`,
    `reporting_category`, then descriptors `ED, EX, D, EM, IE`;
  - each text field `String(x ?? '').trim()` (null and `''` collapse to the same);
  - IE defaults to `'Insufficient Evidence'` (matching the store / export);
  - **case preserved** — descriptor prose is meaningful.
- **Excluded** from the hash: `name`, `source`, db ids, `position` numbers
  (order is implied by array index), and `external_id` — so the digest matches the
  portable shape `read_rubric` / `exportRubricCsv` produce, and "Design" vs
  "Weather App Design" with identical content hash the same.
- Uses `node:crypto` `createHash('sha256')`.

`findRubricByContentHash(db, hash)` in `rubricStore.js` (compute-on-read):
iterate `listRubrics(db)` ids (already ordered `updated_at DESC`), `getRubric` each,
`hashRubricContent` it, return the first match (`{ id, name }`) or `null`. Newest
wins, consistent with `getRubricByName`.

## 4. Server changes

### 4.1 `rubricStore.js`
- New `findRubricByContentHash(db, hash)` (§3).
- `upsertRubricByName` is **superseded for the MCP path** by the new branching
  `writeRubric` handler (§5.1); it stays in the store as a primitive but
  `write_rubric` no longer calls it blindly. (Keep the function + its test —
  CLAUDE.md "preserve verified intel".)

### 4.2 `rubricCsv` / upload route — exact reuse
`POST /api/rubrics/upload` (`server/routes/rubrics.js`): after `parseRubricCsv`,
compute `hash = hashRubricContent(content)` and `match = findRubricByContentHash`.
- **Exact match** → return `{ id: match.id, name: match.name, criteria_count,
  reused: true, match: 'exact' }` — **no new row created**.
- **No match** → `saveRubric` (create) as today → `{ id, name, criteria_count,
  reused: false }`.
- Same-name-different-content is **not** special-cased here (stays create-new;
  the dialog is #111).

## 5. MCP tools (`mcp/handlers.js` + `mcp/server.js`)

### 5.1 `write_rubric` (changed) — library-only, dedup + conflict
Signature gains an optional `on_name_conflict`:
`write_rubric({ name, criteria, on_name_conflict?: 'prompt' | 'update' | 'new' })`
(default `'prompt'`).

Handler logic (`writeRubric(db, { name, criteria, on_name_conflict })`):
1. Build `content` (`source: 'mcp'`, `position = index + 1`); `hash = hashRubricContent(content)`.
2. `exact = findRubricByContentHash(db, hash)` → if found, **no write**; return
   `{ reused_existing: exact.name, match: 'exact', criteria_count }`.
   (If `exact.name !== name`, the agent reports "identical to your existing
   'Design' — reused that, no copy".)
3. Else `named = getRubricByName(db, name)`:
   - **exists** (content differs, since no exact match):
     - `on_name_conflict === 'update'` → `saveRubric(content, named.id)` (replace) →
       `{ name, match: 'updated', criteria_count }`.
     - `on_name_conflict === 'new'` → `saveRubric(content)` (create) →
       `{ name, match: 'created_new', criteria_count }`.
     - else (`'prompt'`) → **no write**; return
       `{ conflict: 'name', existing: name, existing_criteria_count,
       message: 'A different rubric named "<name>" already exists. Re-call with
       on_name_conflict:"update" to replace it, or "new" to save a separate copy.' }`.
   - **absent** → `saveRubric(content)` (create) → `{ name, match: 'created', criteria_count }`.

Tool description (server.js) updated to explain: exact-content reuse, the
name-conflict prompt, and the `on_name_conflict` resolution values.

### 5.2 `attach_rubric` (new) — bind a library rubric to an assignment
`attach_rubric({ rubric_name, assignment_id })`:
- Resolve rubric by name (newest) → id; error result if not found.
- Resolve `assignment_id` (the local Prism assignment id, as returned by
  `list_assignments`) → its `schoology_assignment_id` + `course_id` from the
  `assignments` table.
- Call `attachRubric(db, { rubricId, courseId, assignmentId: schoologyId })` — which
  auto-matches criteria→topics server-side (same path the modal uses).
- Return `{ attached_to: assignment_id, rubric: rubric_name, unmatched_criteria:
  unmatched }` so the agent can say "attached; N criteria still need a topic —
  finish in the Map tab" (the agent can't map topics; there is no mapping MCP tool).
- Registered in `server.js` with a zod `inputSchema { rubric_name, assignment_id }`.

End-to-end: *"set up the design rubric for the weather app"* = agent calls
`write_rubric` (dedup/conflict resolved) then `attach_rubric`, and reports the
combined story (`reused_existing` + `attached_to` + any `unmatched`).

## 6. Client — CSV-upload reuse message

`RubricManagerModal.jsx` `doUpload`: use the route's `{ id, reused, name }`.
After attaching, when `reused` is true show
*"Identical to existing '<name>' — attached it, no copy created."*; otherwise the
normal flow. (Reuses the existing `msg` banner; no new component.)

## 7. Sequencing (TDD throughout)

1. **Fingerprint** — `rubricHash.js` + `findRubricByContentHash` in `rubricStore.js`.
   Tests: `rubricHash.test.js` (same content/diff name → same hash; descriptor
   change → different; IE default & null/'' normalization don't change the hash;
   name/source/external_id excluded), `rubricStore.test.js`
   (`findRubricByContentHash` finds an exact match incl. a different name; null when
   none).
2. **MCP** — `writeRubric` branching + `attachRubricTool` in `handlers.js`; tool
   registrations + descriptions in `server.js`. Tests: `mcp/handlers.test.js`
   (all four `write_rubric` branches: exact-reuse, name-conflict-prompt,
   `update`, `new`, plus plain create; `attach_rubric` attaches + returns
   `unmatched_criteria`).
3. **CSV route + modal** — upload reuse in `routes/rubrics.js`; `doUpload` message
   in the modal. Tests: `rubrics.test.js` (identical upload → reused, no new row;
   novel upload → created), `RubricManagerModal.test.jsx` (reuse message shown).

Each step is red → green → refactor with tests beside the module.

## 8. Out of scope / follow-up

- **#111** — fuzzy near-match: diff display + the in-modal "Update existing vs Save
  as new" confirmation dialog (depends on this issue's fingerprint plumbing). The
  CSV same-name-different-content prompt lands there.
- A combined write+attach MCP tool (rejected — two composable tools).
- A stored `content_hash` column (rejected for now — compute-on-read; revisit only
  if a library ever grows to thousands).

## 9. Open questions / risks

- **`attach_rubric` assignment id flavour** — design assumes the *local* Prism
  assignment id (as `list_assignments` returns) and resolves the schoology id +
  course internally. Confirm against how `attachRubric` / the auto-match key on the
  schoology id during step 2; adjust the param if the local→schoology resolution is
  missing.
- **Re-attach to an already-attached assignment** — `rubric_attachments` has
  `UNIQUE(assignment_schoology_id)`. Confirm `attachRubric`'s behaviour (replace vs
  error) and make `attach_rubric` report it sensibly rather than 500.
- **Hash cost** — O(library size) `getRubric` calls per lookup. Negligible at a
  teacher's scale; documented here so a future large-library scenario knows to add
  the cached column (§8).
- **Exact match discards the incoming name** — reusing "Design" when the agent sent
  "Weather App Design" drops the new name. Intended (dedup); the agent reports it
  and the teacher can rename via #112's inline rename.
