import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { getDb } from '../db/index.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/import/powerschool — upload CSV
router.post('/powerschool', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const content = req.file.buffer.toString('utf-8');
    const records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const db = getDb();
    const now = new Date().toISOString();
    let imported = 0;
    let skipped = 0;

    // Flexible column mapping — try common PowerSchool column names
    for (const row of records) {
      const firstName = row['First Name'] || row['first_name'] || row['FirstName'] || row['Student First Name'] || '';
      const lastName = row['Last Name'] || row['last_name'] || row['LastName'] || row['Student Last Name'] || '';
      const email = row['Email'] || row['email'] || row['Student Email'] || row['Email Address'] || '';
      const psId = row['Student ID'] || row['student_id'] || row['PowerSchool ID'] || row['ID'] || '';
      const parentEmail = row['Parent Email'] || row['parent_email'] || row['Guardian Email'] || '';
      const parentPhone = row['Parent Phone'] || row['parent_phone'] || row['Guardian Phone'] || '';

      if (!firstName && !lastName) {
        skipped++;
        continue;
      }

      // Try to match with existing student by name or powerschool_id
      let existing = null;
      if (psId) {
        existing = db.prepare('SELECT id FROM students WHERE powerschool_id = ?').get(psId);
      }
      if (!existing && firstName && lastName) {
        existing = db.prepare('SELECT id FROM students WHERE first_name = ? AND last_name = ?').get(firstName, lastName);
      }

      if (existing) {
        // Update with PowerSchool data
        db.prepare(`
          UPDATE students SET
            powerschool_id = COALESCE(?, powerschool_id),
            email = COALESCE(?, email),
            parent_email = COALESCE(?, parent_email),
            parent_phone = COALESCE(?, parent_phone),
            updated_at = ?
          WHERE id = ?
        `).run(psId || null, email || null, parentEmail || null, parentPhone || null, now, existing.id);
      } else {
        // Insert new student
        db.prepare(`
          INSERT INTO students (powerschool_id, first_name, last_name, email, parent_email, parent_phone, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(psId || null, firstName, lastName, email || null, parentEmail || null, parentPhone || null, now, now);
      }
      imported++;
    }

    res.json({ success: true, imported, skipped, total: records.length });
  } catch (err) {
    console.error('[import] CSV parse error:', err);
    res.status(400).json({ error: `CSV parse error: ${err.message}` });
  }
});

export default router;
