// A controlled checkbox that also reflects the indeterminate (tri-state) visual,
// which React doesn't expose as a prop — set imperatively via a ref. Shared by
// ArchivedImportList (#71; SyncConfig, its other user, went in #171).
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
