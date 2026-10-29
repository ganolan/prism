import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getDb } from './db/index.js';
import { setSectionWriteGuard } from './services/schoology.js';
import { assertSectionWritable } from './services/courseSections.js';
import coursesRouter from './routes/courses.js';
import studentsRouter from './routes/students.js';
import gradesRouter from './routes/grades.js';
import schoologyRouter from './routes/schoology.js';
import importRouter from './routes/import.js';
import notesRouter from './routes/notes.js';
import toolsRouter from './routes/tools.js';
import analyticsRouter from './routes/analytics.js';
import feedbackRouter from './routes/feedback.js';
import masteryRouter from './routes/mastery.js';
import schoologyLoginRouter from './routes/schoologyLogin.js';
import peopleRouter from './routes/people.js';
import rubricsRouter from './routes/rubrics.js';
import assessmentDraftsRouter from './routes/assessment-drafts.js';
import settingsRouter from './routes/settings.js';
import triageRouter from './routes/triage.js';
import gradeFlagsRouter from './routes/gradeFlags.js';
import quizzesRouter from './routes/quizzes.js';
import submissionCommentsRouter from './routes/submissionComments.js';
import submissionFilesRouter from './routes/submissionFiles.js';
import extraTimeRouter from './routes/extraTime.js';
import attendanceRouter from './routes/attendance.js';
import { mountMcp } from './routes/mcp.js';
import { getGradingScalesMap } from './db/scales.js';
import { getFeatures, getServerConfig } from './middleware/featureGate.js';
import { originGuard } from './middleware/originGuard.js';
import { getScaleTable, schoologyScaleId } from './lib/proficiencyScale.js';
import { resolveHost, resolvePort } from './lib/listenConfig.js';
import { resolveVersion } from './lib/version.js';
import { markInterruptedRuns } from './services/syncRuns.js';
import { markUnfinishedFirstSyncs } from './services/sync.js';
import { startPastImport } from './services/pastImport.js';
import { startSyncScheduler } from './services/syncScheduler.js';
import { seedFeedbackSnapshotsIfEmpty } from './services/feedbackSnapshots.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = resolvePort();
const HOST = resolveHost();

const app = express();
// No CORS headers: other sites cannot read Prism's answers. originGuard refuses
// writes sent from another site's page.
app.use('/api', originGuard({ allowed: getServerConfig().allowedOrigins }));
// PrisMCP over HTTP (#131), mounted before the general parser below: /mcp parses its own
// bodies (up to 25 MB, a tool call can carry a rubric or a batch of suggestions). A server that
// is not a deployed release is a dev copy: its tools say so and refuse Schoology writes.
mountMcp(app, { allowedOrigins: getServerConfig().allowedOrigins, devCopy: resolveVersion().mode !== 'release' });
// A submission comment with a file carries it as base64 (up to 15 MB), past the
// default 100 KB; parsed here first, so the general parser below skips it.
app.use('/api/submission-comments', express.json({ limit: '25mb' }));
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
app.use('/api/tools', toolsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api/mastery', masteryRouter);
app.use('/api/schoology-login', schoologyLoginRouter);
app.use('/api/people', peopleRouter);
app.use('/api/rubrics', rubricsRouter);
app.use('/api/assessment-drafts', assessmentDraftsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/triage', triageRouter);
app.use('/api/grade-flags', gradeFlagsRouter);
app.use('/api/quizzes', quizzesRouter);
app.use('/api/submission-comments', submissionCommentsRouter);
app.use('/api/submission-files', submissionFilesRouter);
app.use('/api/extra-time', extraTimeRouter);
app.use('/api/attendance', attendanceRouter);

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
// #178: no Schoology REST write reaches a section of a linked set (courseSections.js).
setSectionWriteGuard((sectionId) => assertSectionWritable(getDb(), sectionId));
// First start after the Amendment B deploy: snapshot visible feedback once so
// arrivals show before the first sync (best-effort; logs and carries on).
{
  const seed = seedFeedbackSnapshotsIfEmpty(getDb());
  if (seed.seeded) console.log(`[feedback snapshots] seeded at boot (${seed.arrivals} arrival(s))`);
}
app.listen(PORT, HOST, () => {
  console.log(`Prism server running on http://${HOST}:${PORT}`);
  // A fresh process has no sync running, so any run still marked 'running' was
  // cut off by a crash/restart/deploy — record it as interrupted (a client
  // following it by polling then stops instead of waiting forever). Done only
  // once this process owns the port: a second server that fails to bind (e.g.
  // a dev copy pointed at the same DB) must not interrupt the live one's run.
  const interrupted = markInterruptedRuns(getDb());
  if (interrupted) console.log(`[sync] Marked ${interrupted} unfinished sync run(s) as interrupted`);
  // A course a lost run left waiting for its first read shows as "Sync failed" (#171).
  const unread = markUnfinishedFirstSyncs(getDb());
  if (unread) console.log(`[sync] Marked ${unread} course(s) whose first read never finished as failed`);
  // The background import of past courses (#171): continues after each import run, starts after
  // the first run's kind 'all' run, and resumes an import this restart cut off.
  startPastImport({ db: getDb() });
  // Nightly scheduled sync (Settings → Scheduled sync). Armed only where the prod
  // launchd agent sets PRISM_SCHEDULED_SYNC=1 — dev clones carry prod's settings
  // in their copied database and must not sync on their own.
  startSyncScheduler({ db: getDb(), active: process.env.PRISM_SCHEDULED_SYNC === '1' });
});
