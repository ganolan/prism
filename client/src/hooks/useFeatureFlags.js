import { useState, useEffect } from 'react';
import { getFeatures } from '../services/api.js';

export function useFeatureFlags() {
  const [features, setFeatures] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // A read that answers nothing (or fails) leaves every feature off.
    Promise.resolve().then(getFeatures).then((f) => setFeatures(f || {})).catch(console.error).finally(() => setLoading(false));
  }, []);

  return { features, loading };
}
