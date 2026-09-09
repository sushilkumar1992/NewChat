import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../services/api.js";
import { streamMessage } from "../services/streamClient.js";
import { newSessionId } from "../services/session.js";
import { isNegative, isAffirmative } from "../services/replies.js";
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
  const awaitingMoreRef = useRef(false);
  const busyRef = useRef(false);
  const endedRef = useRef(false);
  const openedRef = useRef(false);
  const endedAtRef = useRef(null);
  const messagesRef = useRef([]);

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
    awaitingMoreRef.current = true;
    addBot(config.followUp);
  }, [config.followUp, addBot]);

  const streamAsk = useCallback(
    (text) => {
      setBusy(true);
      busyRef.current = true;
      const id = mkId();
      setMessages((prev) => [...prev, { id, role: "bot", text: "", ts: Date.now(), loading: true, streaming: true, answer: true, query: text }]);

      streamMessage(
        { sessionId: sessionRef.current, text },
        {
          onToken: (tok) => patch(id, (m) => ({ loading: false, text: m.text + tok })),
          onDone: (evt) => {
            patch(id, {
              loading: false,
              streaming: false,
              images: evt.images || null,
              imageMode: evt.imageMode || null,
              escalation: !!evt.escalation,
              ts: Date.now()
            });
            setBusy(false);
            busyRef.current = false;
            askAnythingElse();
          },
          onError: (msg) => {
            patch(id, { loading: false, streaming: false, text: msg || "Sorry, something went wrong. Please try again." });
            setBusy(false);
            busyRef.current = false;
          }
        }
      );
    },
    [patch, askAnythingElse]
  );

  const sendText = useCallback(
    (raw) => {
      if (busyRef.current || endedRef.current) return;
      const text = String(raw || "").trim();
      if (!text) return;
      addUser(text);

      if (awaitingMoreRef.current) {
        awaitingMoreRef.current = false;
        if (isNegative(text)) return endChat();
        if (isAffirmative(text)) return addBot(config.followUpYes);
        // otherwise treat as a new question → fall through
      }
      streamAsk(text);
    },
    [addUser, addBot, config.followUpYes, streamAsk]
  );

  const sendSuggestion = useCallback(
    (question) => {
      if (busyRef.current || endedRef.current) return;
      awaitingMoreRef.current = false;
      addUser(question);
      streamAsk(question);
    },
    [addUser, streamAsk]
  );

  const endChat = useCallback(() => {
    if (endedRef.current || busyRef.current) return;
    addBot(config.closing);
    endedRef.current = true;
    setEnded(true);
    setFeedbackOpen(true);
  }, [addBot, config.closing]);

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
        questionCount
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
    awaitingMoreRef.current = false;
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
