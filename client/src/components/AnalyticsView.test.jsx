import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import AnalyticsView from './AnalyticsView.jsx';
import { DataVersionContext } from '../hooks/useDataVersion.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js');

// Never resolve the fetch: AnalyticsView stays in its loading state (a plain
// div, no charts), so we can assert the re-fetch behavior without rendering
// recharts. AnalyticsView is shared by AnalyticsPage and CoursePage's analytics
// tab, so this one test covers both surfaces.
const pending = () => new Promise(() => {});

function tree(version) {
  return (
    <DataVersionContext.Provider value={version}>
      <AnalyticsView id="5" />
    </DataVersionContext.Provider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getCourseAnalytics).mockReturnValue(pending());
});

describe('AnalyticsView data refresh', () => {
  it('re-fetches analytics when the data version changes (e.g. after a sync)', async () => {
    const { rerender } = render(tree(0));
    await waitFor(() => expect(api.getCourseAnalytics).toHaveBeenCalledTimes(1));

    rerender(tree(1));
    await waitFor(() => expect(api.getCourseAnalytics).toHaveBeenCalledTimes(2));
  });
});
