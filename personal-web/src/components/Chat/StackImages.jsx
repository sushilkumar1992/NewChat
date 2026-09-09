import ShotFigure from "./ShotFigure.jsx";
import { useLightbox } from "../../context/LightboxContext.jsx";

// Multiple images shown one below the other (no stepper).
export default function StackImages({ images }) {
  const lightbox = useLightbox();
  return (
    <>
      {images.map((im, idx) => (
        <ShotFigure
          key={idx}
          src={im.url}
          caption={im.caption}
          stepLabel={`Step ${idx + 1} of ${images.length}`}
          onClick={() => lightbox.open({ images, mode: "stack", store: null }, idx)}
        />
      ))}
    </>
  );
}
