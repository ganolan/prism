// A one-line note at phone width on the pages that stay desktop tools (grading,
// the gradebook grid, analytics, import): they work, but are built for a wider
// screen. `phone-only`, so desktop never shows it (#134).
export default function LargerScreenNote() {
  return (
    <p className="alert alert-info text-sm phone-only larger-screen-note">
      Best on a larger screen.
    </p>
  );
}
