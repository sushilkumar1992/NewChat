"""
Example Bedrock AgentCore runtime that produces the stream our streaming Lambda consumes.

Wire contract (see docs/agentcore-response.md): the runtime streams Server-Sent Events, one
JSON object per `data:` line. Our Lambda extracts token text from event.contentBlockDelta.delta.text
/ delta.text / text / a raw string, and reads endSession, escalation, images and imageMode from a
structured line (top level or under `metadata`). A trailing `[DONE]` is optional.

Streaming in AgentCore: return an (async) generator from the @app.entrypoint. AgentCore emits each
yielded item as one SSE `data:` line — a dict is JSON-encoded, a string is sent verbatim. So
yielding {"text": "hi"} becomes  ->  data: {"text": "hi"}

Requirements: pip install bedrock-agentcore boto3
"""

import json
import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

# Any Bedrock text model you use for the answer.
bedrock = boto3.client("bedrock-runtime")
MODEL_ID = "anthropic.claude-3-5-sonnet-20240620-v1:0"


@app.entrypoint
async def invoke(payload):
    # Our Lambda sends: {"prompt": <text>, "session_id": <uuid>, "actor_id": "default-user"}
    payload = payload or {}
    prompt = payload.get("prompt") or payload.get("text") or ""
    session_id = payload.get("session_id")

    async def stream():
        # 1) Stream the answer text, token by token.
        answer_parts = []
        for delta in stream_answer(prompt):
            answer_parts.append(delta)
            yield {"text": delta}                 # -> data: {"text": "..."}
        answer = "".join(answer_parts)

        # 2) Decide the end-of-session / escalation signals and any images.
        #    Replace these stubs with your own model logic / tool output.
        end_session = detect_end_intent(prompt, answer)
        escalate = detect_escalation(prompt, answer)
        images, image_mode = build_images(prompt, answer)   # ([], None) when there are no images

        # 3) Emit ONE signals line (flags + images). Send it once.
        signals = {"endSession": bool(end_session), "escalation": bool(escalate)}
        if images:
            signals["images"] = images            # [{"url": "...", "caption": "..."}]
            signals["imageMode"] = image_mode      # "single" | "stepper" | "stack"
        yield signals                             # -> data: {"endSession": false, "images": [...], ...}

        # 4) Optional end sentinel (the Lambda ignores it).
        yield "[DONE]"

    return stream()


def stream_answer(prompt):
    """Yield answer text deltas from Bedrock Converse streaming."""
    resp = bedrock.converse_stream(
        modelId=MODEL_ID,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
    )
    for event in resp["stream"]:
        if "contentBlockDelta" in event:
            text = event["contentBlockDelta"]["delta"].get("text")
            if text:
                yield text
    # --- Alternative: forward Bedrock's native events unchanged ---
    # Our Lambda also reads event.contentBlockDelta.delta.text, so instead of {"text": ...}
    # you may `yield event` directly for each Converse event and skip the reshaping above.


# ----------------------------------------------------------------------------
# Plug-in points — implement these with your model / business logic.
# ----------------------------------------------------------------------------
def detect_end_intent(prompt, answer):
    """True when the user is finished (e.g. 'no thanks', 'that's all'). The UI then shows
    the closing message + feedback panel. A bare 'yes' is a normal turn -> return False."""
    return False


def detect_escalation(prompt, answer):
    """True to hint the answer needs a human agent."""
    return False


def build_images(prompt, answer):
    """Return (images, image_mode). images = [{"url": <https>, "caption": <optional>}].
    image_mode = 'single' | 'stepper' | 'stack'. Return ([], None) for a text-only answer.

    Example — a 3-step how-to rendered as a stepper:
        return ([
            {"url": "https://cdn.example.com/step1.png", "caption": "Open Settings"},
            {"url": "https://cdn.example.com/step2.png", "caption": "Tap Security"},
            {"url": "https://cdn.example.com/step3.png", "caption": "Choose Reset password"},
        ], "stepper")
    """
    return [], None


if __name__ == "__main__":
    # AgentCore container entrypoint.
    app.run()
