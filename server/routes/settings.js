import { Router } from 'express';
import { getDb } from '../db/index.js';
import { getTriageSettings, updateTriageSettings } from '../services/settings.js';

const router = Router();

// GET /api/settings — { triage: { referralLimitDays, feedbackLimitDays, warnLeadDays, showFormativeDefault } }
router.get('/', (req, res) => {
  res.json({ triage: getTriageSettings(getDb()) });
});

// PUT /api/settings — body { triage: { ...partial } }; values are clamped server-side.
router.put('/', (req, res) => {
  res.json({ triage: updateTriageSettings(getDb(), req.body?.triage || {}) });
});

export default router;
