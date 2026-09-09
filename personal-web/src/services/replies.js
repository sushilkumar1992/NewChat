// Detects short yes/no answers to the "Is there anything else…?" follow-up (ported from the vanilla app).
function normLite(t) {
  return String(t).toLowerCase().replace(/[^a-z\s']/g, " ").replace(/\s+/g, " ").trim();
}
const NEG = ["no", "nope", "nah", "no thanks", "no thank you", "nothing", "nothing else", "nothing more",
  "that's all", "thats all", "that is all", "that's it", "thats it", "all good", "i'm good", "im good", "i am good",
  "good for now", "we're good", "were good", "done", "i'm done", "im done", "no more", "that will be all",
  "i'm fine", "im fine", "i am fine", "all set", "im all set", "i'm all set"];
const AFF = ["yes", "yeah", "yep", "yup", "sure", "yes please", "ok", "okay", "yea", "i do"];

export function isNegative(t) {
  const n = normLite(t);
  if (String(t).indexOf("?") >= 0) return false;
  if (n.split(" ").length > 7) return false;
  return NEG.some((p) => n === p || (" " + n + " ").indexOf(" " + p + " ") >= 0);
}
export function isAffirmative(t) {
  const n = normLite(t);
  if (n.split(" ").length > 3) return false;
  return AFF.some((p) => n === p || (" " + n + " ").indexOf(" " + p + " ") >= 0);
}
