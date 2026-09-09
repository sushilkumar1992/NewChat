import { useEffect, useState } from "react";
import { api } from "../../services/api.js";

// Dynamic top-5 most-asked questions from GET /suggestions. Hidden entirely until there is data.
export default function Suggestions({ onPick, disabled }) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getSuggestions()
      .then((r) => alive && setItems((r && r.suggestions) || []))
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!items.length) return null; // no suggestions yet → area hidden

  return (
    <div className="suggest-wrap">
      <button className={"suggest-toggle" + (open ? " open" : "")} onClick={() => setOpen((o) => !o)}>
        <span>💡 Suggested questions</span>
        <span className="chev">▾</span>
      </button>
      <div className={"suggest-list" + (open ? " open" : "")}>
        {items.map((s) => (
          <button
            key={s.id}
            className="chip"
            disabled={disabled}
            onClick={() => { setOpen(false); onPick(s.question); }}
          >
            {s.question}
          </button>
        ))}
      </div>
    </div>
  );
}
