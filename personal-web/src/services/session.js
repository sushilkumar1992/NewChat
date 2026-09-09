// Client-generated session id. The frontend OWNS the session id for the entire
// lifecycle (open the chat -> stream messages -> submit feedback); the backend only
// CONSUMES it and never allocates one. Generated once per chat session in useChat.open().
//
// Uses the browser's native RFC 4122 v4 generator when available (secure contexts /
// modern browsers) and falls back to a crypto-strong (or, last resort, Math.random)
// v4 for http/localhost or older browsers so a session id is ALWAYS produced.
export function newSessionId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch (e) {
    /* fall through to manual v4 */
  }

  const bytes = new Uint8Array(16);
  try {
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
  } catch (e) {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  // Per RFC 4122 v4: set version (4) and variant (10xx) bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [];
  for (let i = 0; i < 16; i++) hex.push((bytes[i] + 0x100).toString(16).slice(1));
  return (
    hex[0] + hex[1] + hex[2] + hex[3] + "-" +
    hex[4] + hex[5] + "-" +
    hex[6] + hex[7] + "-" +
    hex[8] + hex[9] + "-" +
    hex[10] + hex[11] + hex[12] + hex[13] + hex[14] + hex[15]
  );
}
