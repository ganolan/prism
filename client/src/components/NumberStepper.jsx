// A controlled [−] N [+] integer stepper. Emits clamped integer values via
// onChange. Non-numeric typed input is ignored (the field stays controlled).
export default function NumberStepper({ value, onChange, min = 1, max = 365, ...rest }) {
  const clamp = (n) => Math.min(max, Math.max(min, Math.floor(n)));
  const emit = (n) => { if (Number.isFinite(n)) onChange(clamp(n)); };
  return (
    <span className="number-stepper">
      <button
        type="button" className="number-stepper__btn" aria-label="Decrease"
        onClick={() => emit(value - 1)} disabled={value <= min}
      >−</button>
      <input
        type="number" inputMode="numeric" min={min} max={max} value={value}
        onChange={(e) => { const n = parseInt(e.target.value, 10); if (!Number.isNaN(n)) emit(n); }}
        {...rest}
      />
      <button
        type="button" className="number-stepper__btn" aria-label="Increase"
        onClick={() => emit(value + 1)} disabled={value >= max}
      >+</button>
    </span>
  );
}
