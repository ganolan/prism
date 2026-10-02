import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getDb } from './db/index.js';
import coursesRouter from './routes/courses.js';
import studentsRouter from './routes/students.js';
import gradesRouter from './routes/grades.js';
import schoologyRouter from './routes/schoology.js';
import importRouter from './routes/import.js';
import notesRouter from './routes/notes.js';
import flagsRouter from './routes/flags.js';
import toolsRouter from './routes/tools.js';
import analyticsRouter from './routes/analytics.js';
import feedbackRouter from './routes/feedback.js';
import masteryRouter from './routes/mastery.js';
import peopleRouter from './routes/people.js';
import rubricsRouter from './routes/rubrics.js';
import assessmentDraftsRouter from './routes/assessment-drafts.js';
import settingsRouter from './routes/settings.js';
import triageRouter from './routes/triage.js';
import { getGradingScalesMap } from './db/scales.js';
import { getFeatures } from './middleware/featureGate.js';
import { getScaleTable, schoologyScaleId } from './lib/proficiencyScale.js';
import { resolveHost, resolvePort } from './lib/listenConfig.js';
import { resolveVersion } from './lib/version.js';
import { markInterruptedRuns } from './services/syncRuns.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = resolvePort();
const HOST = resolveHost();

const app = express();
app.use(cors());
app.use(express.json());

// Serve static client build in production
const clientDist = join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));

// API routes
app.use('/api/courses', coursesRouter);
app.use('/api/students', studentsRouter);
app.use('/api/grades', gradesRouter);
app.use('/api', schoologyRouter);
app.use('/api/import', importRouter);
app.use('/api/notes', notesRouter);
app.use('/api/flags', flagsRouter);
app.use('/api/tools', toolsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api/mastery', masteryRouter);
app.use('/api/people', peopleRouter);
app.use('/api/rubrics', rubricsRouter);
app.use('/api/assessment-drafts', assessmentDraftsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/triage', triageRouter);

// Feature flags endpoint
app.get('/api/features', (req, res) => {
  res.json(getFeatures());
});

// What build is answering — the deployed SHA and build time, or dev.
app.get('/api/version', (req, res) => {
  res.json(resolveVersion());
});

// Grading scales — global lookup map for the client to render scale-aware
// labels (Complete, ED, etc.) anywhere a grade is shown.
app.get('/api/grading-scales', (req, res) => {
  res.json(getGradingScalesMap());
});

// Proficiency scale — ordered levels array + Schoology scale ID for the client.
app.get('/api/proficiency-scale', (req, res) => {
  res.json({ levels: getScaleTable(), schoologyScaleId: schoologyScaleId() });
});

// SPA fallback — serve index.html for non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(join(clientDist, 'index.html'));
});

// Initialize DB on startup
getDb();
console.log('Database initialized');
app.listen(PORT, HOST, () => {
  console.log(`Prism server running on http://${HOST}:${PORT}`);
  // A fresh process has no sync running, so any run still marked 'running' was
  // cut off by a crash/restart/deploy — record it as interrupted (a client
  // following it by polling then stops instead of waiting forever). Done only
  // once this process owns the port: a second server that fails to bind (e.g.
  // a dev copy pointed at the same DB) must not interrupt the live one's run.
  const interrupted = markInterruptedRuns(getDb());
  if (interrupted) console.log(`[sync] Marked ${interrupted} unfinished sync run(s) as interrupted`);
});
