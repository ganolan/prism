/**
 * psBlockNumber.js — pure helpers for resolving a section's "Block N" from
 * PowerSchool's `section_info` payload (issue #106).
 *
 * The block a teacher sees at the top of the attendance-code column is the
 * PowerSchool *period name* (e.g. "Block 3"), NOT the Schoology period/cycle
 * expression and NOT `periodNumber` (verified 2026-06-08: APCSP has
 * periodNumber 7 but displays "Block 6"). It lives in
 *   section_info[0].bellScheduleItems[].period.name
 * filtered to the periodId(s) the section actually meets in
 *   keys(section_info[0].periodIdToPsmPeriodIdMap).
 *
 * See .claude/powerschool-api-reference.md "Block number".
 */

const toArray = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

/**
 * Parse the digit from a "Block N" period name. Returns the number as a string
 * (matching the existing manual-entry format the UI renders as `[BK {n}]`), or
 * null for period names that aren't a numbered block (e.g. "Pastoral Care").
 */
export function blockNumberFromName(name) {
  if (!name || typeof name !== 'string') return null;
  const m = name.trim().match(/^block\s*(\d+)$/i);
  return m ? m[1] : null;
}

/**
 * Resolve the distinct block(s) a section meets in from a section_info[0] object.
 * Returns { periodIds: number[], blocks: [{ name, abbreviation, periodNumber, periodId }] }.
 * Blocks are de-duplicated by period name. bellScheduleItems may arrive as an
 * array or an integer-keyed object map.
 */
export function resolveSectionBlock(sectionInfoFirst) {
  if (!sectionInfoFirst || typeof sectionInfoFirst !== 'object') {
    return { periodIds: [], blocks: [] };
  }
  const periodIds = Object.keys(sectionInfoFirst.periodIdToPsmPeriodIdMap || {}).map(Number);
  const periodIdSet = new Set(periodIds);

  const byName = new Map();
  for (const item of toArray(sectionInfoFirst.bellScheduleItems)) {
    if (!item) continue;
    if (periodIdSet.size && !periodIdSet.has(item.periodId)) continue;
    const p = item.period || {};
    if (!p.name) continue;
    const name = p.name.trim();
    if (!byName.has(name)) {
      byName.set(name, {
        name,
        abbreviation: (p.abbreviation || '').trim(),
        periodNumber: p.periodNumber,
        periodId: p.id,
      });
    }
  }
  return { periodIds, blocks: [...byName.values()] };
}

/**
 * Decide the value to store in courses.block_number for a section.
 * Returns { blockNumber, blockName, reason }:
 *   - reason 'ok'           → exactly one numbered block; blockNumber is the digit
 *   - reason 'not-numbered' → exactly one block but not "Block N" (PCG/Interim)
 *   - reason 'no-block'     → no resolvable block
 *   - reason 'ambiguous'    → more than one distinct block (don't guess)
 * blockNumber is only non-null for reason 'ok'.
 */
export function pickBlockNumber(sectionInfoFirst) {
  const { blocks } = resolveSectionBlock(sectionInfoFirst);
  if (blocks.length === 0) return { blockNumber: null, blockName: null, reason: 'no-block' };
  if (blocks.length > 1) return { blockNumber: null, blockName: null, reason: 'ambiguous' };
  const { name } = blocks[0];
  const blockNumber = blockNumberFromName(name);
  return blockNumber
    ? { blockNumber, blockName: name, reason: 'ok' }
    : { blockNumber: null, blockName: name, reason: 'not-numbered' };
}

/**
 * Decide the DB effect of examining one course, given the resolved pick and the
 * sync mode. Returns { setBlockNumber, stampSyncedAt }:
 *   - stampSyncedAt is ALWAYS true — an examined course is marked so the cheap
 *     auto pass never re-fetches it (PCG/Interim/failures included). The manual
 *     "force" refresh re-examines everything regardless of the marker.
 *   - setBlockNumber is the digit only when a numbered block resolved (reason
 *     'ok') AND it's safe to write: in force mode always; in auto mode only when
 *     the course currently has no block_number (never clobber a manual value).
 * `pick` may be a pickBlockNumber() result or any { reason } object (e.g. a
 * fetch failure); null is treated as "no number".
 */
export function planBlockUpdate(course, pick, { force = false } = {}) {
  let setBlockNumber;
  if (pick && pick.reason === 'ok') {
    const empty = course?.block_number == null || course.block_number === '';
    if (force || empty) setBlockNumber = pick.blockNumber;
  }
  return { setBlockNumber, stampSyncedAt: true };
}

/**
 * Extract the PowerSchool sectionDcid from an LTI launch-form HTML response
 * (hidden input `custom_sectiondcid`). Returns null when absent or empty
 * (an empty value denotes a template/master course with no real PS section).
 */
export function sectionDcidFromLaunchForm(html) {
  if (!html || typeof html !== 'string') return null;
  const m = html.match(/name=["']custom_sectiondcid["'][^>]*?value=["']([^"']*)["']/i)
    || html.match(/value=["']([^"']*)["'][^>]*?name=["']custom_sectiondcid["']/i);
  if (!m) return null;
  const dcid = m[1].trim();
  return dcid || null;
}
