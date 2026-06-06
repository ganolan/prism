import { useState } from 'react';

// A [−] N [+] integer stepper. Valid keystrokes commit immediately (clamped) via
// onChange. While focused the field holds raw text in `draft`, so it can be
// cleared and retyped freely; focus selects the value for quick replacement, and
// an empty/invalid field reverts to the committed value on blur.
export default function NumberStepper({ value, onChange, min = 1, max = 365, ...rest }) {
  const clamp = (n) => Math.min(max, Math.max(min, Math.floor(n)));
  const emit = (n) => { if (Number.isFinite(n)) onChange(clamp(n)); };
  // null = not editing (show the committed value); a string = the in-progress edit.
  const [draft, setDraft] = useState(null);
  return (
    <span className="number-stepper">
      <button
        type="button" className="number-stepper__btn" aria-label="Decrease"
        onClick={() => { setDraft(null); emit(value - 1); }} disabled={value <= min}
      >−</button>
      <input
        {...rest}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft ?? String(value)}
        onFocus={(e) => { setDraft(String(value)); e.target.select(); }}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = parseInt(e.target.value, 10);
          if (!Number.isNaN(n)) emit(n);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      <button
        type="button" className="number-stepper__btn" aria-label="Increase"
        onClick={() => { setDraft(null); emit(value + 1); }} disabled={value >= max}
      >+</button>
    </span>
  );
}
