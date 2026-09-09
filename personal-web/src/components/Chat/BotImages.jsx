import { useRef } from "react";
import ShotFigure from "./ShotFigure.jsx";
import Stepper from "./Stepper.jsx";
import StackImages from "./StackImages.jsx";
import { createStepStore } from "../../services/stepStore.js";
import { useLightbox } from "../../context/LightboxContext.jsx";

// Chooses the renderer by imageMode: single | stepper | stack.
export default function BotImages({ images, mode }) {
  const lightbox = useLightbox();
  const storeRef = useRef(null);

  if (mode === "stepper" && images.length > 1) {
    if (!storeRef.current) storeRef.current = createStepStore(images.length);
    return <Stepper images={images} store={storeRef.current} />;
  }
  if (mode === "stack") {
    return <StackImages images={images} />;
  }
  // single (one or more, shown plainly)
  return (
    <>
      {images.map((im, idx) => (
        <ShotFigure
          key={idx}
          src={im.url}
          caption={im.caption}
          onClick={() => lightbox.open({ images, mode: "single", store: null }, idx)}
        />
      ))}
    </>
  );
}
