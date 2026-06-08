import { getDb } from '../db/index.js';

const LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];

// Insert criteria + descriptors for a rubric id (assumes none exist yet).
function insertCriteria(db, rubricId, criteria) {
  const insC = db.prepare(
    `INSERT INTO rubric_criteria (rubric_id, position, criterion_name, standard_title, reporting_category)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insD = db.prepare(
    `INSERT INTO rubric_descriptors (criterion_id, level, descriptor_text) VALUES (?, ?, ?)`
  );
  criteria.forEach((c, i) => {
    const cid = insC.run(rubricId, c.position ?? i + 1, c.criterion_name ?? null,
      c.standard_title ?? null, c.reporting_category ?? null).lastInsertRowid;
    for (const lvl of LEVELS) {
      const text = lvl === 'IE'
        ? (c.descriptors?.IE || 'Insufficient Evidence')
        : (c.descriptors?.[lvl] ?? null);
      insD.run(cid, lvl, text);
    }
  });
}

// Create (id omitted) or fully replace (id given) a rubric's content. Returns the id.
export function saveRubric(db = getDb(), content, id = null) {
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    let rubricId = id;
    if (rubricId == null) {
      rubricId = db.prepare(
        `INSERT INTO rubrics (name, source, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
      ).run(content.name, content.source ?? null, content.notes ?? null, now, now).lastInsertRowid;
    } else {
      db.prepare(`UPDATE rubrics SET name = ?, source = ?, updated_at = ? WHERE id = ?`)
        .run(content.name, content.source ?? null, now, rubricId);
      db.prepare(`DELETE FROM rubric_criteria WHERE rubric_id = ?`).run(rubricId); // cascades descriptors
    }
    insertCriteria(db, rubricId, content.criteria || []);
    return rubricId;
  });
  return txn();
}

export function getRubric(db = getDb(), id) {
  const rubric = db.prepare(`SELECT * FROM rubrics WHERE id = ?`).get(id);
  if (!rubric) return null;
  const criteria = db.prepare(
    `SELECT * FROM rubric_criteria WHERE rubric_id = ? ORDER BY position, id`
  ).all(id);
  const descs = db.prepare(
    `SELECT d.criterion_id, d.level, d.descriptor_text FROM rubric_descriptors d
     JOIN rubric_criteria c ON c.id = d.criterion_id WHERE c.rubric_id = ?`
  ).all(id);
  const byCrit = {};
  for (const d of descs) (byCrit[d.criterion_id] ??= {})[d.level] = d.descriptor_text;
  return {
    ...rubric,
    criteria: criteria.map(c => ({ ...c, descriptors: byCrit[c.id] || {} })),
  };
}

export function listRubrics(db = getDb()) {
  return db.prepare(
    `SELECT r.id, r.name, r.source, r.updated_at,
            (SELECT COUNT(*) FROM rubric_criteria c WHERE c.rubric_id = r.id) AS criteria_count,
            (SELECT COUNT(*) FROM rubric_attachments a WHERE a.rubric_id = r.id) AS attachment_count
     FROM rubrics r ORDER BY r.updated_at DESC, r.id DESC`
  ).all();
}

export function deleteRubric(db = getDb(), id) {
  db.prepare(`DELETE FROM rubrics WHERE id = ?`).run(id);
}

export function getRubricByName(db = getDb(), name) {
  const row = db.prepare(`SELECT id FROM rubrics WHERE name = ? ORDER BY updated_at DESC, id DESC LIMIT 1`).get(name);
  return row ? getRubric(db, row.id) : null;
}

// Upsert by name: replace the newest rubric with this name, else create. Keeps the
// library free of re-push duplicates (the MCP write contract, spec §6).
export function upsertRubricByName(db = getDb(), content) {
  const row = db.prepare(`SELECT id FROM rubrics WHERE name = ? ORDER BY updated_at DESC, id DESC LIMIT 1`).get(content.name);
  return saveRubric(db, content, row?.id ?? null);
}
