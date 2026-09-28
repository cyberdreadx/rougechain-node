/** Site-wide animated backdrop: gradient fields plus a faint HUD grid and scanlines (see `.aurora-*` / `.cyber-*` in index.css). Decorative only. */
export function AuroraBackdrop() {
  return (
    <div className="aurora-backdrop" aria-hidden="true">
      <div className="aurora-blob aurora-blob--a" />
      <div className="aurora-blob aurora-blob--b" />
      <div className="aurora-blob aurora-blob--c" />
      <div className="cyber-grid" />
      <div className="cyber-scanlines" />
      <div className="cyber-scanbeam" />
    </div>
  );
}
