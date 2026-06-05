import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CoursePage from './CoursePage.jsx';
import { DataVersionContext } from '../hooks/useDataVersion.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js');

// Keep the page in its loading state by never resolving the data fetches. The
// effect still runs (on mount and on dependency change), so we can assert the
// gradebook is re-pulled when the data version bumps — without rendering the
// heavy roster/gradebook UI.
function pending() {
  return new Promise(() => {});
}

function tree(version) {
  return (
    <DataVersionContext.Provider value={version}>
      <MemoryRouter initialEntries={['/course/5']}>
        <Routes>
          <Route path="/course/:id" element={<CoursePage />} />
        </Routes>
      </MemoryRouter>
    </DataVersionContext.Provider>
  );
}

beforeEach(() => {
  vi.clearAllMocks(); // call counts are asserted; don't let them accumulate across tests
  vi.mocked(api.getCourse).mockReturnValue(pending());
  vi.mocked(api.getCourseStudents).mockReturnValue(pending());
  vi.mocked(api.getGradebook).mockReturnValue(pending());
  vi.mocked(api.getMasteryForCourse).mockReturnValue(pending());
});

describe('CoursePage data refresh', () => {
  it('re-fetches the gradebook when the data version changes (e.g. after a sync)', async () => {
    const { rerender } = render(tree(0));

    await waitFor(() => expect(api.getGradebook).toHaveBeenCalledTimes(1));
    expect(api.getGradebook).toHaveBeenCalledWith('5');

    // A sync completes → DataVersionContext bumps → the page re-pulls.
    rerender(tree(1));

    await waitFor(() => expect(api.getGradebook).toHaveBeenCalledTimes(2));
  });

  it('does not re-fetch on an unrelated re-render (stable data version)', async () => {
    const { rerender } = render(tree(0));
    await waitFor(() => expect(api.getGradebook).toHaveBeenCalledTimes(1));

    rerender(tree(0));
    // Give any errant effect a chance to fire before asserting it did not.
    await new Promise((r) => setTimeout(r, 0));
    expect(api.getGradebook).toHaveBeenCalledTimes(1);
  });
});
