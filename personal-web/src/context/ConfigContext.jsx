import { createContext, useContext, useEffect, useState } from "react";
import { api } from "../services/api.js";

// Per-message feedback (thumbs up/down) is env-configurable.
// Set VITE_ENABLE_MESSAGE_FEEDBACK=yes|no in personal-web/.env (defaults to enabled).
function envFlag(v, dflt) {
  if (v == null || v === "") return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
const MESSAGE_FEEDBACK = envFlag(import.meta.env.VITE_ENABLE_MESSAGE_FEEDBACK, true);

// Fallback config so the UI renders even before /config responds (or if the API is down in local dev).
const FALLBACK = {
  botName: "Personal",
  greeting: "Hi, I am Personal, your Virtual Assistant. How can I help you today?",
  closing:
    "Thank you for using Personal. We value your trust in us. Please share your valuable feedback (thumbs up/thumbs down) to help us improve the experience.",
  followUp: "Is there anything else I can help you with?",
  followUpYes: "Sure! Go ahead and type your question below.",
  maxQuestionWords: 150,
  csrPhone: "1-800-555-0142",
  feedbackReasons: ["Incorrect answer", "Not relevant", "Missing information", "Other"],
  messageFeedback: MESSAGE_FEEDBACK
};

const ConfigContext = createContext(FALLBACK);
export const useConfig = () => useContext(ConfigContext);

export function ConfigProvider({ children }) {
  const [config, setConfig] = useState(FALLBACK);
  useEffect(() => {
    let alive = true;
    api
      .getConfig()
      .then((c) => alive && c && setConfig({ ...FALLBACK, ...c, messageFeedback: MESSAGE_FEEDBACK }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}
