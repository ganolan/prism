import { createPortal } from 'react-dom';

// A card action's editor (Extend, Ask to resubmit, Waive): drawn as a full-width row
// under the card header (the card passes `host`, its panel row) so the header's
// buttons never wrap; inline when there is no host (tests, other callers).
// Two rows: the deadline (stepper, unit, lesson hint) then the note + actions.
export default function ActionPanel({ host, label, children }) {
  const panel = <div className="action-panel" role="group" aria-label={label}>{children}</div>;
  return host ? createPortal(panel, host) : panel;
}

export const PanelRow = ({ children }) => <div className="action-panel__row">{children}</div>;
