import { readdirSync, readFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getDb } from '../db/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INBOX_DIR = process.env.INBOX_DIR || join(__dirname, '..', '..', 'inbox');
const PROCESSED_DIR = join(INBOX_DIR, 'processed');

// Required fields in the JSON schema
const REQUIRED_FIELDS = ['student_id', 'assignment_id'];

function validate(data, filename) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (data[field] == null || data[field] === '') {
      errors.push(`Missing required field: ${field}`);
    }
  }
  if (data.score != null && typeof data.score !== 'number') {
    errors.push('score must be a number');
  }
  if (data.flag_for_review != null && typeof data.flag_for_review !== 'boolean') {
    errors.push('flag_for_review must be a boolean');
  }
  if (data.strengths && !Array.isArray(data.strengths)) {
    errors.push('strengths must be an array');
  }
  if (data.suggestions && !Array.isArray(data.suggestions)) {
    errors.push('suggestions must be an array');
  }
  return errors;
}

function resolveStudentId(db, rawId) {
  // Try as internal ID first, then schoology_uid, then powerschool_id
  let row = db.prepare('SELECT id FROM students WHERE id = ?').get(rawId);
  if (row) return row.id;
  row = db.prepare('SELECT id FROM students WHERE schoology_uid = ?').get(String(rawId));
  if (row) return row.id;
  row = db.prepare('SELECT id FROM students WHERE powerschool_id = ?').get(String(rawId));
  if (row) return row.id;
  return null;
}

function resolveAssignmentId(db, rawId) {
  let row = db.prepare('SELECT id FROM assignments WHERE id = ?').get(rawId);
  if (row) return row.id;
  row = db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?').get(String(rawId));
  if (row) return row.id;
  return null;
}

function importFeedbackRecord(db, data, filename) {
  const studentId = resolveStudentId(db, data.student_id);
  if (!studentId) return { error: `Student not found: ${data.student_id}` };

  const assignmentId = resolveAssignmentId(db, data.assignment_id);
  if (!assignmentId) return { error: `Assignment not found: ${data.assignment_id}` };

  const feedbackJson = JSON.stringify({
    strengths: data.strengths || [],
    suggestions: data.suggestions || [],
    narrative_feedback: data.narrative_feedback || '',
    rubric_scores: data.rubric_scores || {},
    overall_grade: data.overall_grade || null,
    graded_at: data.graded_at || null,
  });

  const result = db.prepare(`
    INSERT INTO feedback (submission_id, student_id, assignment_id, status, score,
      flag_for_review, flag_reason, feedback_json, source_file)
    VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)
  `).run(
    data.submission_id || null,
    studentId,
    assignmentId,
    data.score ?? null,
    data.flag_for_review ? 1 : 0,
    data.flag_reason || null,
    feedbackJson,
    filename || null
  );

  return { feedbackId: result.lastInsertRowid };
}

export function processInbox() {
  const db = getDb();

  if (!existsSync(INBOX_DIR)) {
    mkdirSync(INBOX_DIR, { recursive: true });
  }
  if (!existsSync(PROCESSED_DIR)) {
    mkdirSync(PROCESSED_DIR, { recursive: true });
  }

  const files = readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'));
  const results = { processed: 0, errors: 0, details: [] };

  for (const file of files) {
    const filepath = join(INBOX_DIR, file);
    try {
      const raw = readFileSync(filepath, 'utf-8');
      const data = JSON.parse(raw);

      // Handle single object or array of feedback items
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        const validationErrors = validate(item, file);
        if (validationErrors.length > 0) {
          db.prepare('INSERT INTO inbox_log (filename, status, error_message) VALUES (?, ?, ?)')
            .run(file, 'error', validationErrors.join('; '));
          results.errors++;
          results.details.push({ file, status: 'error', errors: validationErrors });
          continue;
        }

        const importResult = importFeedbackRecord(db, item, file);
        if (importResult.error) {
          db.prepare('INSERT INTO inbox_log (filename, status, error_message) VALUES (?, ?, ?)')
            .run(file, 'error', importResult.error);
          results.errors++;
          results.details.push({ file, status: 'error', error: importResult.error });
        } else {
          db.prepare('INSERT INTO inbox_log (filename, status, feedback_id) VALUES (?, ?, ?)')
            .run(file, 'imported', importResult.feedbackId);
          results.processed++;
          results.details.push({ file, status: 'imported', feedbackId: importResult.feedbackId });
        }
      }

      // Move to processed
      renameSync(filepath, join(PROCESSED_DIR, file));
    } catch (err) {
      db.prepare('INSERT INTO inbox_log (filename, status, error_message) VALUES (?, ?, ?)')
        .run(file, 'error', err.message);
      results.errors++;
      results.details.push({ file, status: 'error', error: err.message });
    }
  }

  return results;
}

// Import a single feedback record directly (from API upload or manual entry)
export function importSingleFeedback(data, filename) {
  const db = getDb();
  const validationErrors = validate(data);
  if (validationErrors.length > 0) {
    return { error: validationErrors.join('; ') };
  }
  return importFeedbackRecord(db, data, filename);
}
