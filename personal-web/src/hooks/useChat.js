import { useCallback, useRef, useState } from "react";
import { api } from "../services/api.js";
import { streamMessage } from "../services/streamClient.js";
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

  const addBot = useCallback((text, extra = {}) => {
    setMessages((prev) => [...prev, { id: mkId(), role: "bot", text, ts: Date.now(), ...extra }]);
  }, []);
  const addUser = useCallback((text) => {
    setMessages((prev) => [...prev, { id: mkId(), role: "user", text, ts: Date.now() }]);
  }, []);
  const patch = useCallback((id, updater) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...(typeof updater === "function" ? updater(m) : updater) } : m)));
  }, []);

  const open = useCallback(async () => {
    if (openedRef.current) return;
    openedRef.current = true;
    startedAtRef.current = Date.now();
    let greeting = config.greeting;
    try {
      const res = await api.createSession({ theme: null });
      sessionRef.current = res.sessionId;
      if (res.greeting) greeting = res.greeting;
    } catch (e) {
      sessionRef.current = "local-" + Math.random().toString(36).slice(2, 8); // design-review fallback
    }
    addBot(greeting);
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
    let durationS = startedAtRef.current ? Math.round((Date.now() - startedAtRef.current) / 1000) : null;
    try {
      const res = await api.postFeedback(sessionRef.current, { rating, reasons, other });
      if (res && res.durationMs != null) durationS = Math.round(res.durationMs / 1000);
    } catch (e) {}
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
    setMessages([]);
    setBusy(false);
    setEnded(false);
    setFeedbackOpen(false);
    open();
  }, [open]);

  return { messages, busy, ended, feedbackOpen, open, sendText, sendSuggestion, endChat, submitFeedback, rateMessage, startNew };
}
