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
