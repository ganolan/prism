import { useState, useEffect } from 'react';
import { getFeatures } from '../services/api.js';

export function useFeatureFlags() {
  const [features, setFeatures] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getFeatures().then(setFeatures).catch(console.error).finally(() => setLoading(false));
  }, []);

  return { features, loading };
}
