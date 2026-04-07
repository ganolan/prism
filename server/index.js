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
import { getFeatures } from './middleware/featureGate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// Serve uploaded profile images
const uploadsDir = join(__dirname, 'uploads');
app.use('/uploads', express.static(uploadsDir));

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

// Feature flags endpoint
app.get('/api/features', (req, res) => {
  res.json(getFeatures());
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

app.listen(PORT, () => {
  console.log(`Prism server running on http://localhost:${PORT}`);
});
