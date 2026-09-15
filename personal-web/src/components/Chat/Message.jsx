import TypingIndicator from "./TypingIndicator.jsx";
import BotImages from "./BotImages.jsx";
import { useConfig } from "../../context/ConfigContext.jsx";

function timeStr(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Turns bare URLs in a plain string into clickable links that open in a new tab. Everything
// stays React-escaped (the URL is set via the href prop and the visible text is a child string —
// no dangerouslySetInnerHTML), so this is safe against injection. `target="_blank"` +
// `rel="noopener noreferrer"` opens a new tab without giving the opened page access to ours.
const URL_RE = /((?:https?:\/\/|www\.)[^\s]+)/gi;
function linkify(str, keyPrefix) {
  const s = String(str);
  const out = [];
  let last = 0, m, i = 0;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(s)) !== null) {
    let url = m[0];
    const start = m.index;
    // Don't swallow trailing punctuation/brackets that follow the URL in a sentence.
    const trail = url.match(/[.,;:!?)\]}'"]+$/);
    let tail = "";
    if (trail) { tail = trail[0]; url = url.slice(0, -tail.length); }
    if (!url) { // the match was pure punctuation — skip, emit as text
      out.push(s.slice(last, start + m[0].length));
      last = start + m[0].length; continue;
    }
    if (start > last) out.push(s.slice(last, start));
    const href = /^www\./i.test(url) ? "https://" + url : url;
    out.push(
      <a key={keyPrefix + "-l" + i} className="chat-link" href={href} target="_blank" rel="noopener noreferrer">{url}</a>
    );
    if (tail) out.push(tail);
    last = start + m[0].length;
    i++;
  }
  if (last < s.length) out.push(s.slice(last));
  return out.length ? out : [s];
}

// Splits a plain string on "\n" into text + <br> nodes, linkifying URLs on each line
// (React escapes all text; only real URLs become <a> elements).
function withBreaks(str, keyPrefix) {
  const lines = String(str).split("\n");
  return lines.map((line, i) => (
    <span key={keyPrefix + "-" + i}>
      {linkify(line, keyPrefix + "-" + i)}
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
  // Once a vote exists, `msg-fb--voted` lets CSS dim the thumb that wasn't chosen; the chosen
  // one gets `.active` (green for up, red for down — see styles.css).
  return (
    <div className={"msg-fb" + (m.rating ? " msg-fb--voted" : "")}>
      <button
        type="button"
        className={"msg-fb__btn msg-fb__btn--up" + (m.rating === "up" ? " active" : "")}
        title="Helpful"
        aria-label="Helpful"
        aria-pressed={m.rating === "up"}
        onClick={() => vote("up")}
      >
        👍
      </button>
      <button
        type="button"
        className={"msg-fb__btn msg-fb__btn--down" + (m.rating === "down" ? " active" : "")}
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

  // bot — render an ordered list of blocks (text / images) so images appear inline at the
  // position they streamed in. Falls back to a single text block for messages that carry only
  // `text` (greeting, closing, and older records without blocks).
  const blocks = (m.blocks && m.blocks.length)
    ? m.blocks
    : (m.text ? [{ type: "text", text: m.text }] : []);
  // Index of the last TEXT block — the streaming caret lives there so it trails the answer.
  let lastTextIdx = -1;
  blocks.forEach((b, i) => { if (b.type === "text") lastTextIdx = i; });

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
        {m.loading ? (
          <div className="bubble" style={{ padding: 0 }}><TypingIndicator /></div>
        ) : (
          blocks.map((b, i) =>
            b.type === "images" ? (
              (b.images && b.images.length > 0) ? (
                <div className="msg__images" key={i}>
                  <BotImages images={b.images} mode={b.imageMode || "single"} />
                </div>
              ) : null
            ) : (
              <div className="bubble" key={i}>
                <TextBody text={b.text} streaming={m.streaming && i === lastTextIdx} />
              </div>
            )
          )
        )}
        {!m.loading && !m.streaming && <div className="msg__time">{timeStr(m.ts)}</div>}
        {config.messageFeedback && !m.loading && !m.streaming && m.answer && (
          <MsgFeedback m={m} onRate={onRate} />
        )}
      </div>
    </div>
  );
}
