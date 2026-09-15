import { useEffect, useRef } from "react";
import Message from "./Message.jsx";
import FeedbackPanel from "./FeedbackPanel.jsx";

export default function MessageList({ messages, feedbackOpen, onSubmitFeedback, onRestart, onRate }) {
  const bodyRef = useRef(null);
  const anchoredIdRef = useRef(null);

  // Scroll behaviour: when a NEW turn starts, pin the user's question to the TOP of the view so
  // the answer reads from its first line downward and the user scrolls through long / step-by-step
  // answers manually. We deliberately do NOT auto-scroll as tokens/images stream in (that is what
  // made the view chase the last word). We re-anchor only when a new user message appears.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (messages.length === 0) { anchoredIdRef.current = null; return; }

    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return; // only the greeting so far — leave the view at the top

    const lastUser = messages[lastUserIdx];
    if (anchoredIdRef.current === lastUser.id) return; // same turn, still streaming — don't move
    anchoredIdRef.current = lastUser.id;

    // Align the question element's top with the top of the scroll viewport (small gap for breathing room).
    const node = el.children[lastUserIdx];
    if (node) {
      const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
      el.scrollTop += delta - 8;
    }
  }, [messages]);

  // When the session ends, bring the feedback panel into view.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && feedbackOpen) el.scrollTop = el.scrollHeight;
  }, [feedbackOpen]);

  return (
    <div className="chat__body" ref={bodyRef}>
      {messages.map((m) => (
        <Message key={m.id} m={m} onRate={onRate} />
      ))}
      {feedbackOpen && <FeedbackPanel onSubmit={onSubmitFeedback} onRestart={onRestart} />}
    </div>
  );
}
