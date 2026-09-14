# Image payload spec — what the agent must emit to render images in the chatbot UI

To show images in a turn, the agent emits a **JSON event** in its stream (alongside the answer
text). The streaming Lambda relays it to the UI, which renders the images **at the position the
event appears in the stream**. This is the exact shape the UI expects.

## The payload

Emit an object carrying the images (it may also carry the `endSession` / `escalation` flags):

```json
{
  "images": [
    { "url": "https://cdn.example.com/step1.png", "caption": "Open Settings" },
    { "url": "https://cdn.example.com/step2.png", "caption": "Tap Security" },
    { "url": "https://cdn.example.com/step3.png", "caption": "Choose Reset password" }
  ],
  "imageMode": "stepper"
}
```

On the wire (AgentCore SSE) this is one line: `data: {"images":[...],"imageMode":"stepper"}`.

**Placement (updated — images now render inline):** emit the image line **exactly where you want
the image to appear** relative to the text — before it, between text lines, or at the end. You may
emit **more than one** image payload per turn (e.g. some text → a `single` image → more text → a
`stepper` block); each renders in order at its position. Sending the **same** payload twice (say,
once mid-stream and again at the end) renders it **once** — duplicates are collapsed.

**One clean line per payload:** put the image JSON on its **own** `data:` line — do **not** glue it
onto the same line as answer text. (The Lambda tolerates the glued form by splitting text from the
image object, but a standalone line is the reliable contract.)

### Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `images` | array | Yes (to show images) | The images to render, in display order. Omit the whole object for a text-only answer. |
| `images[].url` | string | **Yes** | Absolute **https** URL the browser loads directly. Must be public or **pre-signed** — an auth-blocked/404 URL is silently hidden. |
| `images[].caption` | string | No | Caption shown under the image. |
| `imageMode` | string | No | `"single"` \| `"stepper"` \| `"stack"`. Defaults to `single`. |

## The three render modes

| `imageMode` | Use it for | How it renders in the chat |
|---|---|---|
| `single` | One image, or a few unrelated images | Each image shown inline, click to enlarge (lightbox). |
| `stepper` | An **ordered** how-to / walkthrough (2+ images) | A guided viewer: one image at a time with **Prev / Next**, step dots, and completion ticks. Best for step-by-step instructions. |
| `stack` | A set of related images to view together | All images stacked vertically, each auto-labeled **"Step N of M"**. |

**Ordering matters** for `stepper` and `stack` — the array order is the display order.

## Full example — a 3-step walkthrough

The agent streams text tokens, then the image event:

```
data: Here's how to reset your password:
data: {"images":[{"url":"https://cdn.example.com/step1.png","caption":"Open Settings"},{"url":"https://cdn.example.com/step2.png","caption":"Tap Security"},{"url":"https://cdn.example.com/step3.png","caption":"Choose Reset password"}],"imageMode":"stepper"}
```

### Single image
```
data: Here's your latest statement.
data: {"images":[{"url":"https://cdn.example.com/statement.png","caption":"March statement"}],"imageMode":"single"}
```

### Multiple payloads in one turn (inline)
Text, then an image, then more text, then a stepper — each renders at its position:
```
data: Here's your March statement:
data: {"images":[{"url":"https://cdn.example.com/statement.png","caption":"March statement"}],"imageMode":"single"}
data:  And here's how to download it:
data: {"images":[{"url":"https://cdn.example.com/dl1.png","caption":"Open menu"},{"url":"https://cdn.example.com/dl2.png","caption":"Tap Download"}],"imageMode":"stepper"}
```

### Text-only answer
Emit no image event (or `{"images": []}`). The UI just shows the text.

## Rules for the ML side

1. **URLs must be browser-reachable** — public https or a **pre-signed** S3 URL (the browser fetches them directly; the backend does not proxy them).
2. **Keep image references out of the answer prose.** Source images from your KB retrieval results / tool output and put them in the `images` array — don't inline markdown `![](...)` in the streamed text, or that raw markdown shows in the chat bubble.
3. **Emit each image payload on its own `data:` line, at the position you want it to appear.** You may send several per turn; identical repeats are collapsed to one. Don't glue the image JSON onto a text line.
4. `caption` is optional; `url` is required.
5. Pick `imageMode` by intent: ordered steps → `stepper`, a gallery to view together → `stack`, otherwise → `single`.

## What the UI ultimately receives

The streaming Lambda forwards **each** image payload inline, in stream order, as its own `image`
event, then finishes with `done` (which no longer carries images):

```json
{ "type": "image", "images": [ { "url": "…", "caption": "…" } ], "imageMode": "stepper" }
{ "type": "done", "escalation": false, "endSession": false }
```

The frontend appends each `image` event at the position it arrives — between text or at the end —
and renders the gallery/stepper/stack there. If the agent sends no images, no `image` event is
emitted and the UI just shows the text answer.
