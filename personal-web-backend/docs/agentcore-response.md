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

To render images in the chat, emit **one structured line** carrying `images` and `imageMode` (top level or under `metadata`). The Lambda relays them on its `done` event and the UI renders them.

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

Notes: emit the images line **once** (if repeated, the last value wins). Send it any time before the stream ends — typically right after the explanatory text. If a turn has no images, just omit the fields.

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

## 6. What the Lambda then sends to the browser

The Lambda relays tokens and finishes with a `done` event that includes the images:

```
{"type":"start"}
{"type":"token","text":"Here's how to reset your password:"}
{"type":"done","escalation":false,"endSession":false,"images":[{"url":"https://cdn.example.com/step1.png","caption":"Open Settings"}, …],"imageMode":"stepper"}
```

The frontend reads `images` / `imageMode` off that `done` event to render the gallery/stepper. If the agent sends no images, they arrive as `null` and the UI just shows the text answer.
