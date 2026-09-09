import { useEffect, useRef } from "react";
import Message from "./Message.jsx";
import FeedbackPanel from "./FeedbackPanel.jsx";

export default function MessageList({ messages, feedbackOpen, onSubmitFeedback, onRestart, onRate }) {
  const bodyRef = useRef(null);

  // Auto-scroll to the newest content (messages streaming in, feedback panel).
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, feedbackOpen]);

  return (
    <div className="chat__body" ref={bodyRef}>
      {messages.map((m) => (
        <Message key={m.id} m={m} onRate={onRate} />
      ))}
      {feedbackOpen && <FeedbackPanel onSubmit={onSubmitFeedback} onRestart={onRestart} />}
    </div>
  );
}
