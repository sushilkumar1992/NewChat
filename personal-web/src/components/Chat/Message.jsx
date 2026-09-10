import TypingIndicator from "./TypingIndicator.jsx";
import BotImages from "./BotImages.jsx";
import { useConfig } from "../../context/ConfigContext.jsx";

function timeStr(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Renders text with <br> for newlines (text is plain; React escapes it).
function TextBody({ text, streaming }) {
  const parts = String(text).split("\n");
  return (
    <>
      {parts.map((line, i) => (
        <span key={i}>
          {line}
          {i < parts.length - 1 && <br />}
        </span>
      ))}
      {streaming && <span className="caret" />}
    </>
  );
}

// Thumbs up/down for a single bot answer (responses to user queries only).
// Re-submittable: the user can change their vote any number of times. The active
// thumb stays highlighted; each click re-sends and the backend updates the same record.
function MsgFeedback({ m, onRate }) {
  const vote = (rating) => onRate && onRate(m.id, rating, { query: m.query, answer: m.text });
  return (
    <div className="msg-fb">
      <button
        type="button"
        className={"msg-fb__btn" + (m.rating === "up" ? " active" : "")}
        title="Helpful"
        aria-label="Helpful"
        aria-pressed={m.rating === "up"}
        onClick={() => vote("up")}
      >
        👍
      </button>
      <button
        type="button"
        className={"msg-fb__btn" + (m.rating === "down" ? " active" : "")}
        title="Not helpful"
        aria-label="Not helpful"
        aria-pressed={m.rating === "down"}
        onClick={() => vote("down")}
      >
        👎
      </button>
    </div>
  );
}

export default function Message({ m, onRate }) {
  const config = useConfig();
  if (m.role === "user") {
    return (
      <div className="msg msg--user">
        <div className="msg__col msg__col--user">
          <div className="bubble"><TextBody text={m.text} /></div>
          <div className="msg__time">{timeStr(m.ts)}</div>
        </div>
      </div>
    );
  }

  // bot
  return (
    <div className="msg msg--bot">
      <img
        className="msg__avatar-img"
        src="/assets/personal-mark.png"
        alt="R"
        onError={(e) => {
          const d = document.createElement("div");
          d.className = "msg__avatar";
          d.textContent = "R";
          e.target.replaceWith(d);
        }}
      />
      <div className="msg__col">
        <div className="bubble" style={m.loading ? { padding: 0 } : undefined}>
          {m.loading ? <TypingIndicator /> : <TextBody text={m.text} streaming={m.streaming} />}
        </div>
        {!m.loading && !m.streaming && <div className="msg__time">{timeStr(m.ts)}</div>}
        {m.images && m.images.length > 0 && (
          <div className="msg__images">
            <BotImages images={m.images} mode={m.imageMode || "single"} />
          </div>
        )}
        {config.messageFeedback && !m.loading && !m.streaming && m.answer && (
          <MsgFeedback m={m} onRate={onRate} />
        )}
      </div>
    </div>
  );
}
