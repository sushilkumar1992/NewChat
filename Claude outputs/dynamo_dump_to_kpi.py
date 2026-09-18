#!/usr/bin/env python3
"""
Convert a DynamoDB (RBPOCTable) dump CSV into the dataset that kpi.html expects.

INPUT   A CSV dump of RBPOCTable — one row per item. Easiest source:
        DynamoDB console -> Tables -> RBPOCTable -> Explore items -> run a Scan
        -> Actions -> "Download results to CSV". (Full-table PITR "Export to S3"
        works too, but that produces DynamoDB-typed JSON; this script also copes
        with typed values if you convert that export to CSV.)

OUTPUT  kpi-data.js  ->  window.KPI_DATA = { sessions, messages, suggestions, reasons }
        (add --json to also emit kpi-data.json)

WIRING (kpi.html), two tiny changes:
    1) add, just before the main <script> block:
         <script src="./kpi-data.js"></script>
    2) change the one data-source line:
         const ALL = generateSampleData(90);
       to:
         const ALL = window.KPI_DATA || generateSampleData(90);

Run:  python3 dynamo_dump_to_kpi.py RBPOCTable-dump.csv -o kpi-data.js --json
"""
import csv, json, argparse
from collections import defaultdict, Counter
from datetime import datetime, timezone


def as_bool(v):
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("true", "1", "yes", "y") if v is not None else False


def as_num(v):
    if v is None or v == "":
        return None
    try:
        f = float(v)
        return int(f) if f.is_integer() else f
    except (TypeError, ValueError):
        return None


def num0(v):
    n = as_num(v)
    return n if isinstance(n, (int, float)) else 0


def iso_from_ms(ms):
    try:
        return datetime.fromtimestamp(float(ms) / 1000, tz=timezone.utc).isoformat()
    except Exception:
        return None


def parse_maybe_json(v):
    """`reasons` / suggestions `items` may export as JSON (plain or DynamoDB-typed)."""
    if v is None or v == "":
        return None
    if isinstance(v, (list, dict)):
        return v
    try:
        return json.loads(v)
    except Exception:
        return None


def dynamo_unwrap(x):
    """Unwrap DynamoDB-typed JSON ({'S':..},{'N':..},{'L':..},{'M':..}) to plain values."""
    if isinstance(x, dict) and len(x) == 1:
        (t, val), = x.items()
        if t == "S":    return val
        if t == "N":    return as_num(val)
        if t == "BOOL": return bool(val)
        if t == "NULL": return None
        if t == "L":    return [dynamo_unwrap(i) for i in val]
        if t == "M":    return {k: dynamo_unwrap(v) for k, v in val.items()}
    if isinstance(x, list):
        return [dynamo_unwrap(i) for i in x]
    if isinstance(x, dict):
        return {k: dynamo_unwrap(v) for k, v in x.items()}
    return x


def item_type(row):
    t = (row.get("type") or "").strip()
    if t:
        return t
    pk, sk = (row.get("PK") or ""), (row.get("SK") or "")
    if pk == "SUGGESTIONS": return "SUGGESTIONS"
    if pk == "CONFIG":      return "CONFIG"
    if sk == "META":        return "SESSION_META"
    if sk.startswith("MSG#"): return "MESSAGE"
    return "OTHER"


def sid_of(row):
    return row.get("sessionId") or (row.get("PK") or "").replace("SESSION#", "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv_path")
    ap.add_argument("-o", "--out", default="kpi-data.js")
    ap.add_argument("--json", action="store_true", help="also write kpi-data.json")
    args = ap.parse_args()

    metas = {}                       # sessionId -> SESSION_META row
    msgs_by_sid = defaultdict(list)  # sessionId -> [MESSAGE rows]
    suggestions = []

    with open(args.csv_path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            t = item_type(row)
            if t == "SESSION_META":
                metas[sid_of(row)] = row
            elif t == "MESSAGE":
                msgs_by_sid[sid_of(row)].append(row)
            elif t == "SUGGESTIONS":
                raw = dynamo_unwrap(parse_maybe_json(row.get("items")) or [])
                for s in (raw or []):
                    if isinstance(s, dict) and s.get("question"):
                        suggestions.append({"question": str(s["question"]),
                                            "count": num0(s.get("count"))})

    sessions, messages = [], []
    for sid in (set(metas) | set(msgs_by_sid)):
        mrows = msgs_by_sid.get(sid, [])
        turn_ts, in_tot, out_tot, escalated = [], 0, 0, False
        for m in mrows:
            it, ot = num0(m.get("inputTokens")), num0(m.get("outputTokens"))
            in_tot += it; out_tot += ot
            if as_bool(m.get("escalation")):
                escalated = True
            ts = as_num(m.get("ts"))
            if ts is not None:
                turn_ts.append(ts)
            messages.append({
                "sessionId": sid,
                "messageId": m.get("messageId"),
                "question": m.get("question"),
                "answer": m.get("answer"),
                "ts": ts,
                "inputTokens": it, "outputTokens": ot,
                "feedbackRating": (m.get("feedbackRating") or None),
                "images": None, "imageMode": None,
            })

        meta = metas.get(sid)
        if meta:
            started = meta.get("startedAt") or (iso_from_ms(min(turn_ts)) if turn_ts else None)
            ended   = meta.get("endedAt")   or (iso_from_ms(max(turn_ts)) if turn_ts else None)
            dur     = as_num(meta.get("durationMs"))
            qcount  = as_num(meta.get("questionCount"))
            in_m    = as_num(meta.get("inputTokenTotal"))
            out_m   = as_num(meta.get("outputTokenTotal"))
            rating  = meta.get("rating") or None
            reasons = dynamo_unwrap(parse_maybe_json(meta.get("reasons")) or []) or []
        else:  # session with messages but no META (user never ended/rated it)
            started = iso_from_ms(min(turn_ts)) if turn_ts else None
            ended   = iso_from_ms(max(turn_ts)) if turn_ts else None
            dur = qcount = in_m = out_m = rating = None
            reasons = []

        if dur is None and turn_ts:
            dur = int(max(turn_ts) - min(turn_ts))
        if qcount is None:
            qcount = len(mrows)
        if in_m is None:
            in_m = in_tot
        if out_m is None:
            out_m = out_tot

        sessions.append({
            "sessionId": sid,
            "startedAt": started, "endedAt": ended,
            "durationMs": dur or 0,
            "questionCount": qcount or 0,
            "rating": rating if rating in ("up", "down") else None,
            "escalation": escalated,
            "endedBy": "user" if escalated else "bot",   # heuristic: table doesn't store who ended
            "inputTokenTotal": in_m or 0,
            "outputTokenTotal": out_m or 0,
            "_reasons": [r for r in reasons if r],
        })

    # a session needs a start time to sit on the time axis
    sessions = [s for s in sessions if s["startedAt"]]

    reason_counter = Counter()
    for s in sessions:
        for r in s.pop("_reasons", []):
            reason_counter[str(r)] += 1
    reasons = [{"reason": r, "count": c} for r, c in reason_counter.most_common()]

    suggestions.sort(key=lambda s: s["count"], reverse=True)

    data = {"sessions": sessions, "messages": messages,
            "suggestions": suggestions, "reasons": reasons}

    with open(args.out, "w", encoding="utf-8") as f:
        f.write("window.KPI_DATA = ")
        json.dump(data, f, ensure_ascii=False)
        f.write(";\n")
    if args.json:
        with open(args.out.rsplit(".", 1)[0] + ".json", "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"sessions={len(sessions)}  messages={len(messages)}  "
          f"suggestions={len(suggestions)}  reasons={len(reasons)}  ->  {args.out}")


if __name__ == "__main__":
    main()
