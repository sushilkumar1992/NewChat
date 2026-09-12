import TypingIndicator from "./TypingIndicator.jsx";
import BotImages from "./BotImages.jsx";
import { useConfig } from "../../context/ConfigContext.jsx";

function timeStr(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Splits a plain string on "\n" into text + <br> nodes (React escapes the text).
function withBreaks(str, keyPrefix) {
  const lines = String(str).split("\n");
  return lines.map((line, i) => (
    <span key={keyPrefix + "-" + i}>
      {line}
      {i < lines.length - 1 && <br />}
    </span>
  ));
}

// Renders streamed answer text: **bold** -> <strong>, "\n" -> <br> (text stays
// plain — React escapes it, so this is not raw HTML).
//
// The FULL accumulated text is re-parsed on every token, so a "**...**" pair whose
// markers arrive in different chunks (opening "**" now, closing "**" several tokens
// later) resolves the moment both are present — no cross-chunk buffering needed here.
// Splitting on "**" makes odd-indexed segments bold; a still-open "**" (no closing
// yet) therefore renders its text bold live as more tokens stream in. While streaming
// we also hide a lone trailing "*" (the first half of a not-yet-complete "**") so a
// single asterisk never flashes for one frame between chunks.
function renderRich(text, streaming) {
  let src = String(text);
  if (streaming) {
    const m = src.match(/\*+$/);              // trailing run of "*"
    if (m && m[0].length % 2 === 1) src = src.slice(0, -1); // odd -> last one is a half-typed marker
  }
  const segments = src.split("**");           // odd indices = bold (closed, or open while streaming)
  return segments.map((seg, i) =>
    i % 2 === 1
      ? <strong key={"b" + i}>{withBreaks(seg, "b" + i)}</strong>
      : <span key={"n" + i}>{withBreaks(seg, "n" + i)}</span>
  );
}

function TextBody({ text, streaming }) {
  return (
    <>
      {renderRich(text, streaming)}
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
