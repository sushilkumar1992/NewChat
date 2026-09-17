import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../services/api.js";
import { streamMessage } from "../services/streamClient.js";
import { newSessionId } from "../services/session.js";
import { useConfig } from "../context/ConfigContext.jsx";

let seq = 0;
const mkId = () => "m" + Date.now().toString(36) + "_" + ++seq;

export function useChat() {
  const config = useConfig();
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const sessionRef = useRef(null);
  const startedAtRef = useRef(null);
  const busyRef = useRef(false);
  const endedRef = useRef(false);
  const openedRef = useRef(false);
  const endedAtRef = useRef(null);
  const messagesRef = useRef([]);
  // Running session totals of the agent's per-turn token usage (from each stream's `done`). Kept
  // in a ref (not state) so accumulating never triggers a re-render; sent with the session feedback.
  const tokensRef = useRef({ input: 0, output: 0 });

  // Keep a ref to the latest transcript so submitFeedback can read message counts
  // at end-of-session without re-creating the callback on every new message.
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const addBot = useCallback((text, extra = {}) => {
    setMessages((prev) => [...prev, { id: mkId(), role: "bot", text, ts: Date.now(), ...extra }]);
  }, []);
  const addUser = useCallback((text) => {
    setMessages((prev) => [...prev, { id: mkId(), role: "user", text, ts: Date.now() }]);
  }, []);
  const patch = useCallback((id, updater) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...(typeof updater === "function" ? updater(m) : updater) } : m)));
  }, []);

  const open = useCallback(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    startedAtRef.current = Date.now();
    tokensRef.current = { input: 0, output: 0 };   // fresh token tally per session

    // The sessionId is generated on the client and owned for the entire session
    // (open -> messages -> feedback). It lives only in memory, so a browser refresh
    // starts a brand-new session. The backend never allocates a session id — there is
    // no session-start round-trip.
    sessionRef.current = newSessionId();

    // Greeting is served by /config (via ConfigContext).
    addBot(config.greeting);
  }, [config.greeting, addBot]);

  const askAnythingElse = useCallback(() => {
    if (endedRef.current) return;
    // Follow-up prompt ("Is there anything else I can help you with?") is hidden for
    // now — intentionally a no-op. Restore by re-enabling the line below.
    // addBot(config.followUp);
  }, [config.followUp, addBot]);

  // Ends the session UI: opens the feedback panel, and (unless skipped) appends the frontend
  // closing message. Reached two ways:
  //   - the manual "End chat" button -> no LLM closing exists, so we DO show config.closing.
  //   - the backend LLM signalling endSession on a streamed answer -> the LLM already streamed
  //     its own closing text, so we pass { skipClosing: true } and show THAT instead of config.closing.
  // Idempotent via endedRef.
  const beginEnd = useCallback((opts) => {
    if (endedRef.current) return;
    if (!(opts && opts.skipClosing)) addBot(config.closing);
    endedRef.current = true;
    setEnded(true);
    setFeedbackOpen(true);
  }, [addBot, config.closing]);

  const streamAsk = useCallback(
    (text) => {
      setBusy(true);
      busyRef.current = true;
      const id = mkId();
      // A bot answer is an ORDERED list of content blocks so images render inline at the
      // position they stream in: [{type:"text",text}, {type:"images",images,imageMode}, ...].
      // `text` still holds the full concatenated answer text (used for feedback + the record).
      setMessages((prev) => [...prev, { id, role: "bot", text: "", blocks: [], ts: Date.now(), loading: true, streaming: true, answer: true, query: text }]);

      // Track this turn's content in the closure (NOT React state) so onDone can decide
      // synchronously whether the LLM streamed a closing — reading state here would race the
      // pending token updates, since the last token and the `done` line can arrive together.
      let accText = "";
      let accHasImages = false;

      streamMessage(
        { sessionId: sessionRef.current, text, messageId: id },
        {
          onToken: (tok) => { accText += tok; patch(id, (m) => {
            // Append to the trailing text block, or open a new one after an image block.
            const blocks = m.blocks ? m.blocks.slice() : [];
            const last = blocks[blocks.length - 1];
            if (last && last.type === "text") blocks[blocks.length - 1] = { ...last, text: last.text + tok };
            else blocks.push({ type: "text", text: tok });
            return { loading: false, text: (m.text || "") + tok, blocks };
          }); },
          onImage: (evt) => { if (evt.images && evt.images.length) accHasImages = true; patch(id, (m) => {
            // Drop an image block at the current stream position (between text, or at the end).
            const blocks = m.blocks ? m.blocks.slice() : [];
            blocks.push({ type: "images", images: evt.images || [], imageMode: evt.imageMode || "single" });
            return { loading: false, blocks };
          }); },
          onDone: (evt) => {
            // Accumulate this turn's token usage into the session totals, and stamp it on the
            // message (handy for export/debug). Missing/non-numeric counts add 0.
            const inTok = Number(evt.inputTokens) || 0;
            const outTok = Number(evt.outputTokens) || 0;
            tokensRef.current.input += inTok;
            tokensRef.current.output += outTok;
            patch(id, { loading: false, streaming: false, escalation: !!evt.escalation, inputTokens: inTok, outputTokens: outTok, ts: Date.now() });
            setBusy(false);
            busyRef.current = false;
            // The backend LLM decides whether this turn ends the session.
            if (evt.endSession) {
              // Closing turn: SHOW the LLM's own streamed closing text (its "Thank you for using…"
              // response) — do NOT append the frontend config.closing. This bubble is the closing,
              // not a rateable Q&A answer, so unflag it (no thumbs, excluded from message counts).
              const llmClosed = accText.trim() !== "" || accHasImages;
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.id === id) {
                  if (!llmClosed) return prev.slice(0, -1); // LLM sent nothing -> drop the empty bubble
                  return prev.map((m) => (m.id === id ? { ...m, answer: false } : m));
                }
                return prev;
              });
              // Keep the LLM closing; only fall back to config.closing if the LLM streamed nothing.
              beginEnd({ skipClosing: llmClosed });
            } else {
              askAnythingElse();
            }
          },
          onError: (msg) => {
            patch(id, { loading: false, streaming: false, text: msg || "Sorry, something went wrong. Please try again." });
            setBusy(false);
            busyRef.current = false;
          }
        }
      );
    },
    [patch, askAnythingElse, beginEnd]
  );

  const sendText = useCallback(
    (raw) => {
      if (busyRef.current || endedRef.current) return;
      const text = String(raw || "").trim();
      if (!text) return;
      // Every reply — including "no thanks" or "yes" — goes to the stream. The backend
      // LLM classifies intent and signals endSession when the user is done; the client
      // no longer guesses with keyword matching.
      addUser(text);
      streamAsk(text);
    },
    [addUser, streamAsk]
  );

  const sendSuggestion = useCallback(
    (question) => {
      if (busyRef.current || endedRef.current) return;
      addUser(question);
      streamAsk(question);
    },
    [addUser, streamAsk]
  );

  const endChat = useCallback(() => {
    if (busyRef.current) return; // ignore the button while an answer is still streaming
    beginEnd();
  }, [beginEnd]);

  const submitFeedback = useCallback(async (rating, reasons, other) => {
    // The session officially ends HERE — only after the user provides feedback.
    const startedMs = startedAtRef.current;
    const endedMs = Date.now();
    endedAtRef.current = endedMs;
    const durationMs = startedMs != null ? endedMs - startedMs : null;
    const durationS = durationMs != null ? Math.round(durationMs / 1000) : null;

    const msgs = messagesRef.current;
    // Real conversation volume only: user messages + bot answers. Excludes bot system
    // lines (greeting, closing, and "Is there anything else?" follow-ups).
    const messageCount = msgs.filter((m) => m.role === "user" || (m.role === "bot" && m.answer)).length;
    const questionCount = msgs.filter((m) => m.role === "bot" && m.answer).length; // answered questions

    // The frontend owns the entire session record; the backend only consumes and
    // persists it (DynamoDB) and must NOT recompute or override the duration.
    try {
      await api.postFeedback(sessionRef.current, {
        rating,
        reasons,
        other,
        startedAt: startedMs != null ? new Date(startedMs).toISOString() : null,
        endedAt: new Date(endedMs).toISOString(),
        durationMs,
        messageCount,
        questionCount,
        // Session token totals = sum of every turn's usage reported by the agent.
        inputTokenTotal: tokensRef.current.input,
        outputTokenTotal: tokensRef.current.output
      });
    } catch (e) { /* best-effort — the UI still shows the session summary */ }

    return durationS;
  }, []);

  // Per-message thumbs up/down on a bot answer. One-time; also sent to the backend.
  const rateMessage = useCallback((id, rating, meta = {}) => {
    patch(id, { rating });
    (async () => {
      try {
        await api.postMessageFeedback(sessionRef.current, {
          messageId: id,
          rating,
          query: meta.query || null,
          answer: meta.answer || null
        });
      } catch (e) { /* non-blocking: UI already reflects the vote */ }
    })();
  }, [patch]);

  const startNew = useCallback(() => {
    openedRef.current = false;
    sessionRef.current = null;
    busyRef.current = false;
    endedRef.current = false;
    endedAtRef.current = null;
    setMessages([]);
    setBusy(false);
    setEnded(false);
    setFeedbackOpen(false);
    open();
  }, [open]);

  return { messages, busy, ended, feedbackOpen, open, sendText, sendSuggestion, endChat, submitFeedback, rateMessage, startNew };
}
