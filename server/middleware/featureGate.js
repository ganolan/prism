import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CONFIG_PATH || join(__dirname, '..', '..', 'config.yaml');

let config = null;

function loadConfig() {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  config = yaml.load(raw);
  return config;
}

export function getFeatures() {
  if (!config) loadConfig();
  return config.features || {};
}

export function getSyncConfig() {
  if (!config) loadConfig();
  return {
    submissionConcurrency: 2,
    submissionRatePerSec: 4,
    submissionAbandonAfter: 5,
    ...(config.sync || {}),
  };
}

export function getRubricConfig() {
  if (!config) loadConfig();
  return {
    suggestionAccent: '#e21ad6',
    suggestionWash: '#fbe6fb',
    reportingCategoryColors: { produce: '#B4A7D6', create: '#9FC5E8' },
    ...(config.rubrics || {}),
  };
}

export function getSchoologyConfig() {
  if (!config) loadConfig();
  return {
    // The school's Schoology web domain (SSO vanity host). Assignment links are
    // rewritten onto this host — the API's web_url points at app.schoology.com,
    // which doesn't resolve to the school tenant. See lib/schoologyWebUrl.js.
    webBaseUrl: 'https://schoology.hkis.edu.hk',
    ...(config.schoology || {}),
  };
}

export const DEFAULT_PROFICIENCY_SCALE = {
  name: 'HKIS General Academic Scale',
  schoologyScaleId: 21337256,
  levels: [
    { code: 'ED', label: 'Exhibiting Depth',      points: 100, gradeScaled: '87.50' },
    { code: 'EX', label: 'Exhibiting',            points: 75,  gradeScaled: '62.50' },
    { code: 'D',  label: 'Developing',            points: 50,  gradeScaled: '37.50' },
    { code: 'EM', label: 'Emerging',              points: 25,  gradeScaled: '12.50' },
    { code: 'IE', label: 'Insufficient Evidence', points: 0,   gradeScaled: '0.00'  },
  ],
};

export function getProficiencyScale() {
  if (!config) loadConfig();
  return { ...DEFAULT_PROFICIENCY_SCALE, ...(config.grading?.proficiencyScale || {}) };
}

export function featureGate(featureName) {
  return (req, res, next) => {
    const features = getFeatures();
    if (features[featureName]) {
      next();
    } else {
      res.status(403).json({ error: `Feature "${featureName}" is not enabled` });
    }
  };
}
