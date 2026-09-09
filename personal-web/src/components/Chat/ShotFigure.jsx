// One image figure with optional step label + caption. Click → enlarge (handled by parent).
export default function ShotFigure({ src, caption, stepLabel, onClick }) {
  return (
    <figure className="shot-fig">
      {stepLabel && <div className="shot-step">{stepLabel}</div>}
      <img
        className="shot"
        src={src}
        alt={caption || "Screenshot"}
        onClick={onClick}
        onError={(e) => { e.target.closest(".shot-fig").style.display = "none"; }}
      />
      {caption && <figcaption className="shot-cap">📎 {caption} · click image to enlarge</figcaption>}
    </figure>
  );
}
