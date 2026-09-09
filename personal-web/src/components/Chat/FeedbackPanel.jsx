import { useState } from "react";
import { useConfig } from "../../context/ConfigContext.jsx";

export default function FeedbackPanel({ onSubmit, onRestart }) {
  const { feedbackReasons } = useConfig();
  const [rating, setRating] = useState(null);      // "up" | "down" | null
  const [showReasons, setShowReasons] = useState(false);
  const [showOther, setShowOther] = useState(false);
  const [other, setOther] = useState("");
  const [done, setDone] = useState(null);          // { rating, dur }

  const finish = async (r, reasons, otherText) => {
    const dur = await onSubmit(r, reasons, otherText);
    setDone({ rating: r, dur });
  };

  if (done) {
    return (
      <div className="feedback-panel">
        <div className="fb-done">
          ✓ Thank you! Your feedback was recorded.
          {done.dur != null && <span className="fb-dur"> Session length: {done.dur}s</span>}
        </div>
        <button className="newchat" onClick={onRestart}>＋ Start a new chat</button>
      </div>
    );
  }

  return (
    <div className="feedback-panel">
      <div className="fb-q">Was this session helpful?</div>
      <div className="fb-thumbs">
        <button
          className={"fb-thumb" + (rating === "up" ? " active" : "")}
          title="Yes, helpful"
          onClick={() => { setRating("up"); finish("up", [], ""); }}
        >👍</button>
        <button
          className={"fb-thumb" + (rating === "down" ? " active" : "")}
          title="No, needs improvement"
          onClick={() => { setRating("down"); setShowReasons(true); }}
        >👎</button>
      </div>

      {showReasons && !showOther && (
        <div className="fb-extra">
          <div className="fb-sub">What could be better?</div>
          <div className="fb-reasons">
            {(feedbackReasons || []).map((reason) => (
              <button
                key={reason}
                className="fb-reason"
                onClick={() => {
                  if (reason.toLowerCase() === "other") setShowOther(true);
                  else finish("down", [reason], "");
                }}
              >{reason}</button>
            ))}
          </div>
        </div>
      )}

      {showOther && (
        <div className="fb-extra">
          <div className="fb-sub">Please tell us more:</div>
          <textarea className="fb-other" rows={2} placeholder="Your feedback…" value={other} onChange={(e) => setOther(e.target.value)} />
          <button className="fb-submit" onClick={() => finish("down", ["Other"], other.trim())}>Submit feedback</button>
        </div>
      )}
    </div>
  );
}
