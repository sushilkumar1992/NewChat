// Word-count helpers for the 150-word question cap (ported from the vanilla app).
export function wordCount(str) {
  const t = String(str || "").trim();
  return t ? t.split(/\s+/).length : 0;
}

// Return value trimmed so it never exceeds `max` words (used as a safety net after paste/programmatic input).
export function capWords(value, max) {
  const parts = String(value).split(/\s+/).filter(Boolean);
  return parts.length > max ? parts.slice(0, max).join(" ") : value;
}
