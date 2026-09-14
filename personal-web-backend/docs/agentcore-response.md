# AgentCore → Streaming Lambda response contract

This is what the **Bedrock AgentCore runtime must emit** so the streaming Lambda can relay it to the chatbot UI. Share this with the ML/agent team.

## 1. Wire format

The agent response is a **streamed, newline-delimited SSE feed**. Each line is either:

- `data: <json>` — a JSON object the Lambda parses, or
- `data: [DONE]` — optional end sentinel (ignored).

Lines that don't start with `data:` are ignored. One user turn = one such stream.

## 2. Answer text (tokens)

Emit the answer incrementally. The Lambda pulls token text from the **first** of these it finds on a line (so any one shape works):

```
data: {"event":{"contentBlockDelta":{"delta":{"text":"partial text "}}}}   ← preferred (Bedrock shape)
data: {"delta":{"text":"partial text "}}
data: {"text":"partial text "}
data: "partial text "
```

Lines with no text (e.g. `messageStart`, `contentBlockStop`, `messageStop`) are fine — they're skipped.

## 3. Signals: endSession / escalation

Booleans, at the **top level** or under **`metadata`**. Emit when the model decides them (they default to `false`):

```
data: {"endSession":true,"escalation":false}
data: {"metadata":{"escalation":true}}
```

- `endSession: true` → the UI shows the closing message + feedback panel (auto-close). Set it when the user signals they're done ("no thanks", "that's all"); treat a bare "yes" as a normal turn.
- `escalation: true` → hint that the answer needs a human (reserved for handoff UI).

## 4. Images  ← what you asked about

To render images in the chat, emit a structured line carrying `images` and `imageMode` (top level or under `metadata`).

```
data: {"images":[
  {"url":"https://cdn.example.com/step1.png","caption":"Open Settings"},
  {"url":"https://cdn.example.com/step2.png","caption":"Tap Security"},
  {"url":"https://cdn.example.com/step3.png","caption":"Choose Reset password"}
],"imageMode":"stepper"}
```

**`images`** — array of objects; each object:

| Field | Type | Required | Notes |
|---|---|---|---|
| `url` | string | Yes | Absolute **https** URL the browser can load directly. If the asset is private, emit a pre-signed URL. A URL that fails to load is silently hidden. |
| `caption` | string | No | Shown under the image. |

**`imageMode`** — one of:

| Mode | Renders as |
|---|---|
| `single` | One or more images shown plainly, each clickable to enlarge. (Default if omitted.) |
| `stepper` | A guided step-by-step viewer with Prev/Next and completion ticks. Use for **2+ ordered** images (e.g. a how-to). |
| `stack` | Images stacked vertically, each auto-labeled "Step N of M". |

### Placement — images now render INLINE (updated)

Images render **at the position they appear in the stream**, not all at the bottom. So:

- **You may send images anywhere** — before the text, between text lines, or at the end. Each payload renders exactly where it arrives. Emit the image line **right where you want the image to appear** relative to the surrounding text.
- **You may send more than one image payload per turn.** Example: some intro text → a `single` image → more text → a `stepper` block. Each is rendered in order.
- **Duplicates are collapsed.** If you emit the *same* payload twice (e.g. once mid-stream and again at the end), it renders **once** — so a "repeat at the end" is safe.

### Formatting rule — one clean line per payload (important)

Emit each image payload as **its own `data:` line**, with the JSON object as the whole payload:

```
data: {"images":[{"url":"https://cdn.example.com/x.png","caption":"…"}],"imageMode":"single"}
```

Do **not** glue the JSON onto the same `data:` line as answer text:

```
# AVOID — image JSON glued to text on one line
data: Here's your statement. {"images":[{"url":"…"}],"imageMode":"single"}
```

The Lambda now tolerates the glued form (it splits the text from the image object), but a clean standalone line is the reliable contract — send the text on its own line, then the image payload on the next line. If a turn has no images, just omit the fields.

## 5. Full example — text + a 3-step image walkthrough

```
data: {"event":{"messageStart":{"role":"assistant"}}}
data: {"event":{"contentBlockDelta":{"delta":{"text":"Here's how to reset your password:"}}}}
data: {"images":[{"url":"https://cdn.example.com/step1.png","caption":"Open Settings"},{"url":"https://cdn.example.com/step2.png","caption":"Tap Security"},{"url":"https://cdn.example.com/step3.png","caption":"Choose Reset password"}],"imageMode":"stepper"}
data: {"event":{"messageStop":{"stopReason":"end_turn"}}}
data: {"endSession":false,"escalation":false}
data: [DONE]
```

### Single image
```
data: {"event":{"contentBlockDelta":{"delta":{"text":"Here's your latest statement summary."}}}}
data: {"images":[{"url":"https://cdn.example.com/statement.png","caption":"March statement"}],"imageMode":"single"}
data: [DONE]
```

### Stacked images
```
data: {"images":[{"url":"https://cdn.example.com/a.png","caption":"Front"},{"url":"https://cdn.example.com/b.png","caption":"Back"}],"imageMode":"stack"}
data: [DONE]
```

### Multiple payloads in one turn — text, then an image, then more text, then a stepper
Each payload renders at its own position, in order:
```
data: {"event":{"contentBlockDelta":{"delta":{"text":"Here's your March statement:"}}}}
data: {"images":[{"url":"https://cdn.example.com/statement.png","caption":"March statement"}],"imageMode":"single"}
data: {"event":{"contentBlockDelta":{"delta":{"text":" And here's how to download it:"}}}}
data: {"images":[{"url":"https://cdn.example.com/dl1.png","caption":"Open menu"},{"url":"https://cdn.example.com/dl2.png","caption":"Tap Download"}],"imageMode":"stepper"}
data: {"endSession":false,"escalation":false}
data: [DONE]
```

## 6. What the Lambda then sends to the browser

The Lambda relays tokens **and each image payload, inline, in stream order** as its own `image` event, then finishes with `done`:

```
{"type":"start"}
{"type":"token","text":"Here's how to reset your password:"}
{"type":"image","images":[{"url":"https://cdn.example.com/step1.png","caption":"Open Settings"}, …],"imageMode":"stepper"}
{"type":"done","escalation":false,"endSession":false}
```

The frontend appends each `image` event at the position it arrives (between text, or at the end) and renders the gallery/stepper/stack there. `done` no longer carries `images` — it now only reports `escalation` / `endSession`. If the agent sends no images, no `image` event is emitted and the UI just shows the text answer.
