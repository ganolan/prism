// A controlled checkbox that also reflects the indeterminate (tri-state) visual,
// which React doesn't expose as a prop — set imperatively via a ref. Shared by
// SyncConfig (mastery groups) and ArchivedImportList (#71).
export default function TriCheckbox({ checked, indeterminate, ...rest }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      ref={(el) => { if (el) el.indeterminate = indeterminate; }}
      {...rest}
    />
  );
}
