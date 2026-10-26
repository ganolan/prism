// The FRQ mark filters (spec §12), shared by the Attempts tab's two views (#200; the Free response
// tab's until #200 folded it in).
export const FILTERS = [
  ['all', 'All'], ['review', 'To review'], ['accepted', 'Accepted'], ['waiting', 'Waiting to post'],
  ['posted', 'Posted'], ['failed', 'Failed'], ['changed', 'Changed in Schoology'],
];

export function matchesFilter(response, key) {
  const m = response.mark;
  switch (key) {
    case 'review': return m ? m.state === 'suggested' || m.suggestion_revised : !response.schoology;
    case 'accepted': return !!m && (m.state === 'accepted' || m.state === 'edited');
    case 'waiting': return m?.writeback?.status === 'pending';
    case 'posted': return m?.writeback?.status === 'posted' && !m.changed_in_schoology;
    case 'failed': return m?.writeback?.status === 'failed';
    case 'changed': return !!m?.changed_in_schoology;
    default: return true;
  }
}

// A marking card's identity: keyed by the mark's content, so a saved change (even one that keeps the
// state) restarts the card from it.
export const markKey = (m) => (m ? JSON.stringify([m.state, m.final, m.suggested, m.suggestion_revised]) : 'none');
