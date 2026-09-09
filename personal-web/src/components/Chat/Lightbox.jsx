import { useEffect, useSyncExternalStore } from "react";
import { useLightbox } from "../../context/LightboxContext.jsx";

const NOOP_SUB = () => () => {};

function LightboxInner({ state, close, setIndex }) {
  const { images, store } = state;
  const hasStore = !!store;
  useSyncExternalStore(hasStore ? store.subscribe : NOOP_SUB, hasStore ? store.getSnapshot : () => 0);

  const N = images.length;
  const idx = hasStore ? store.state().index : state.index;
  const done = hasStore ? store.state().done : {};
  const it = images[idx];
  const multi = N > 1;

  const prev = () => { if (hasStore) store.prev(); else if (state.index > 0) setIndex(state.index - 1); };
  const next = () => { if (hasStore) store.next(); else if (state.index < N - 1) setIndex(state.index + 1); };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <div className="lightbox open" onClick={close}>
      {multi && (
        <button className="lb-nav lb-prev" aria-label="Previous image" disabled={idx === 0}
          onClick={(e) => { e.stopPropagation(); prev(); }}>‹</button>
      )}
      <figure className="lb-figure" onClick={(e) => e.stopPropagation()}>
        <img src={it.url} alt="Preview" />
        {hasStore && (
          <div className="lb-steps" style={{ display: "flex" }}>
            {images.map((_, n) => (
              <div key={n} className={"lb-dot" + (n === idx ? " current" : "") + (done[n] ? " completed" : "")}>
                {done[n] ? "✓" : n + 1}
              </div>
            ))}
          </div>
        )}
        <figcaption className="lb-cap">{(hasStore ? `Step ${idx + 1} of ${N} — ` : "") + (it.caption || "")}</figcaption>
        <div className="lb-count">{multi ? `${idx + 1} / ${N}` : ""}</div>
      </figure>
      {multi && (
        <button className="lb-nav lb-next" aria-label="Next image" disabled={!hasStore && idx === N - 1}
          onClick={(e) => { e.stopPropagation(); next(); }}>›</button>
      )}
      <button className="lb-close" aria-label="Close" onClick={(e) => { e.stopPropagation(); close(); }}>✕</button>
    </div>
  );
}

export default function Lightbox() {
  const { state, close, setIndex } = useLightbox();
  if (!state) return null;
  return <LightboxInner state={state} close={close} setIndex={setIndex} />;
}
