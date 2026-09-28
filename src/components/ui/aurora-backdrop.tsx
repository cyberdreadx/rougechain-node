/** Site-wide animated gradient backdrop (see `.aurora-*` in index.css). Decorative only. */
export function AuroraBackdrop() {
  return (
    <div className="aurora-backdrop" aria-hidden="true">
      <div className="aurora-blob aurora-blob--a" />
      <div className="aurora-blob aurora-blob--b" />
      <div className="aurora-blob aurora-blob--c" />
    </div>
  );
}
