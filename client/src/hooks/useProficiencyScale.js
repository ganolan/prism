import { useState, useEffect } from 'react';
import { getProficiencyScale } from '../services/api.js';
import { makeScaleHelpers } from '../lib/masteryLevels.js';

// Fetches the config-derived proficiency scale and returns helpers bound to it.
// Until loaded, `ready` is false and helpers return null — components guard on `ready`.
export function useProficiencyScale() {
  const [scale, setScale] = useState(null);
  useEffect(() => {
    getProficiencyScale().then(setScale).catch(console.error);
  }, []);
  return { ready: !!scale, ...makeScaleHelpers(scale?.levels || []), schoologyScaleId: scale?.schoologyScaleId };
}
