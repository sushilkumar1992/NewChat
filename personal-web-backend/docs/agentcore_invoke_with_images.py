"""
Updated AgentCore Runtime entrypoint (`invoke`) — adds IMAGES (+ endSession / escalation)
so the chatbot UI can render them. Splice the blocks marked `# +++ NEW` into your existing
`invoke` in main.py; the token-streaming part is unchanged from what you already have.

WHY THIS SHAPE
--------------
Your agent already streams text by filtering Strands `data` events and yielding `event["data"]`
(a plain text token). On AgentCore Runtime that becomes an SSE line:  data: <text>
Your streaming Lambda reads those raw-text lines as answer tokens — no change needed there.

To show images, emit ONE extra event after the answer: a small JSON object carrying
`images` + `imageMode` (and the `endSession` / `escalation` flags). Yield it as a **dict** —
AgentCore serialises a dict to `data: {json}`, which the Lambda parses and relays to the UI.
(Yield tokens as strings, the signal as a dict — do not json.dumps the signal, so it can't get
double-encoded.)

Contract consumed by the streaming Lambda (see docs/agentcore-response.md):
  data: To reset your password...                 <- text token (raw string)
  data: {"endSession": false, "escalation": false,
         "images": [{"url": "...", "caption": "..."}], "imageMode": "stepper"}   <- one signal
"""

import re
# from main import create_agent           # your existing factory
# from bedrock_agentcore.runtime import BedrockAgentCoreApp
# app = BedrockAgentCoreApp()


# ---------------------------------------------------------------------------
# @app.entrypoint
async def invoke(payload):
    payload = payload or {}
    user_message = payload.get("prompt") or payload.get("text") or ""
    session_id = payload.get("session_id")
    actor_id = payload.get("actor_id", "anonymous-user")

    agent = create_agent(session_id=session_id, actor_id=actor_id)

    async def stream():
        full_reply = []

        # 1) Stream the answer, token by token — SAME data-event filtering you already use.
        async for event in agent.stream_async(user_message):
            if "data" in event:
                chunk = event["data"]
                full_reply.append(chunk)
                yield chunk                                   # -> wire: data: <text>

        reply_text = "".join(full_reply)

        # +++ NEW: work out images + flags for this turn, then emit ONE signal event.
        images, image_mode = build_images(user_message, reply_text, agent)
        signal = {
            "endSession": bool(detect_end_intent(user_message, reply_text)),
            "escalation": bool(detect_escalation(user_message, reply_text)),
        }
        if images:
            signal["images"] = images        # [{"url": "...", "caption": "..."}]
            signal["imageMode"] = image_mode  # "single" | "stepper" | "stack"
        yield signal                          # dict -> wire: data: {json}   (Lambda relays to UI)
        # +++ END NEW

    return stream()


# ---------------------------------------------------------------------------
# Image source — implement with YOUR knowledge base / tool outputs.
# ---------------------------------------------------------------------------
_MD_IMAGE = re.compile(r"!\[([^\]]*)\]\((https?://[^)\s]+)\)")

def build_images(user_message, reply_text, agent=None):
    """
    Return (images, image_mode) for the UI, or ([], None) for a text-only answer.
      images     = [{"url": <https url>, "caption": <optional>}]
      image_mode = "single" | "stepper" | "stack"

    RECOMMENDED: source images from your Knowledge Base retrieval results / a tool's output
    (e.g. each retrieved doc's associated image URL/S3 pre-signed URL), NOT from the prose —
    that keeps the streamed answer text clean.

    FALLBACK (below): pull any markdown images ![caption](url) the model put in the answer.
    Note: if you use this, that markdown ALSO appears in the chat bubble text — prefer the
    KB-sourced approach, or instruct the model (system prompt) not to inline image markdown.
    """
    imgs = [{"url": url, "caption": cap} for cap, url in _MD_IMAGE.findall(reply_text or "")]
    if not imgs:
        return [], None
    return imgs, ("stepper" if len(imgs) > 1 else "single")


# ---------------------------------------------------------------------------
# Signals — implement with your own logic (stubs default to False).
# ---------------------------------------------------------------------------
def detect_end_intent(user_message, reply_text):
    """True when the user is finished (e.g. 'no thanks', 'that's all'); the UI then closes
    the chat and shows the feedback panel. A bare 'yes' is a normal turn -> False."""
    return False

def detect_escalation(user_message, reply_text):
    """True to hint the turn needs a human agent."""
    return False


# ---------------------------------------------------------------------------
# Local test (mirrors the notebook's `async for chunk in invoke(payload)` cell).
# Text chunks are strings; the final signal is a dict — print both so you can verify images.
# ---------------------------------------------------------------------------
async def _local_test():
    payload = {"prompt": "How do I reset my password?", "session_id": "cli-session-demo"}
    async for chunk in invoke(payload):
        if isinstance(chunk, dict):
            print("\n[signal]", chunk)     # images / endSession / escalation
        else:
            print(chunk, end="", flush=True)
    print()

# if __name__ == "__main__":
#     import asyncio; asyncio.run(_local_test())
