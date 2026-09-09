import { useSyncExternalStore } from "react";
import ShotFigure from "./ShotFigure.jsx";
import { useLightbox } from "../../context/LightboxContext.jsx";

// Inline stepper. State lives in the shared `store` so the Lightbox stays in sync (advancing marks
// the previous step complete in both places).
export default function Stepper({ images, store }) {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { index, done } = store.state();
  const N = images.length;
  const lightbox = useLightbox();
  const im = images[index];

  return (
    <div className="stepper">
      <div className="stepper__bar">
        {images.map((_, n) => (
          <div key={n} style={{ display: "contents" }}>
            <div className={"stepper__dot" + (n === index ? " current" : "") + (done[n] ? " completed" : "")}>
              <span className="stepper__num">{done[n] ? "✓" : n + 1}</span>
            </div>
            {n < N - 1 && <div className="stepper__line" />}
          </div>
        ))}
      </div>

      <div className="stepper__view">
        <ShotFigure
          src={im.url}
          caption={im.caption}
          stepLabel={`Step ${index + 1} of ${N}`}
          onClick={() => lightbox.open({ images, mode: "stepper", store }, index)}
        />
      </div>

      <div className="stepper__controls">
        <button className="step-btn" disabled={index === 0} onClick={() => store.prev()}>‹ Previous</button>
        <span className="stepper__count">Step {index + 1} of {N}</span>
        <button className="step-btn step-btn--primary" onClick={() => store.next()}>
          {index === N - 1 ? "Finish ✓" : "Next ›"}
        </button>
      </div>
    </div>
  );
}
