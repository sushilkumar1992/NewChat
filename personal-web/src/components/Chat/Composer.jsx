import { useEffect, useRef, useState } from "react";
import { useConfig } from "../../context/ConfigContext.jsx";
import { wordCount, capWords } from "../../services/words.js";

export default function Composer({ onSend, disabled }) {
  const { maxQuestionWords } = useConfig();
  const MAX = maxQuestionWords || 150;
  const [value, setValue] = useState("");
  const taRef = useRef(null);

  const wc = wordCount(value);
  const atLimit = wc >= MAX;

  // Hard block: reject any insertion (typing/paste) that would exceed the word limit — before it appears.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const onBeforeInput = (e) => {
      if (!e.inputType || e.inputType.indexOf("insert") !== 0) return;
      let data = e.data;
      if (data == null && e.dataTransfer) data = e.dataTransfer.getData("text");
      if (data == null) data = e.inputType === "insertLineBreak" || e.inputType === "insertParagraph" ? "\n" : "";
      if (!data) return;
      const v = ta.value;
      const next = v.slice(0, ta.selectionStart) + data + v.slice(ta.selectionEnd);
      if (wordCount(next) > MAX) e.preventDefault();
    };
    ta.addEventListener("beforeinput", onBeforeInput);
    return () => ta.removeEventListener("beforeinput", onBeforeInput);
  }, [MAX]);

  // Paste: keep only as many words as fit (rather than rejecting the whole paste).
  const onPaste = (e) => {
    const ta = taRef.current;
    const clip = e.clipboardData;
    if (!ta || !clip) return;
    e.preventDefault();
    const before = ta.value.slice(0, ta.selectionStart);
    const after = ta.value.slice(ta.selectionEnd);
    const used = wordCount(before + " " + after);
    let insert = clip.getData("text") || "";
    const remaining = MAX - used;
    if (remaining <= 0) insert = "";
    else {
      const pw = insert.trim().split(/\s+/).filter(Boolean);
      if (pw.length > remaining) insert = pw.slice(0, remaining).join(" ");
    }
    setValue(before + insert + after);
  };

  const grow = (el) => { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 120) + "px"; };

  const send = () => {
    const text = value.trim();
    if (!text || disabled || wordCount(text) > MAX) return;
    onSend(text);
    setValue("");
    if (taRef.current) taRef.current.style.height = "auto";
  };

  return (
    <>
      <div className="composer">
        <textarea
          ref={taRef}
          rows={1}
          placeholder="Type your message…"
          value={value}
          disabled={disabled}
          onChange={(e) => { setValue(capWords(e.target.value, MAX)); grow(e.target); }}
          onPaste={onPaste}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button className="send-btn" title="Send" disabled={disabled || !value.trim()} onClick={send}>➤</button>
      </div>
      <div className="composer-foot">
        <span className={"word-count" + (atLimit ? " over" : "")}>{wc} / {MAX} words</span>
        <span className="limit-warn">{atLimit ? `Word limit reached (${MAX} words max).` : ""}</span>
      </div>
    </>
  );
}
