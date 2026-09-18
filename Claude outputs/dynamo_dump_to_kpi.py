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

# Cell values that mean "no value" once a NULL / missing attribute is exported to CSV.
_EMPTY = {"", "null", "none", "nan", "undefined"}


def sval(v):
    """A cleaned string, or None for empty / NULL-ish cells."""
    if v is None:
        return None
    s = str(v).strip()
    return None if s.lower() in _EMPTY else s


def as_bool(v):
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("true", "1", "yes", "y") if v is not None else False


def as_num(v):
    s = sval(v)
    if s is None:
        return None
    try:
        f = float(s)
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
    s = sval(v)
    if s is None:
        return None
    if isinstance(v, (list, dict)):
        return v
    try:
        return json.loads(s)
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
    t = sval(row.get("type"))
    if t:
        return t
    pk, sk = (row.get("PK") or ""), (row.get("SK") or "")
    if pk == "SUGGESTIONS": return "SUGGESTIONS"
    if pk == "CONFIG":      return "CONFIG"
    if sk == "META":        return "SESSION_META"
    if sk.startswith("MSG#"): return "MESSAGE"
    return "OTHER"


def sid_of(row):
    return sval(row.get("sessionId")) or (row.get("PK") or "").replace("SESSION#", "") or None


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
            sid = sid_of(row)
            if t == "SESSION_META" and sid:
                metas[sid] = row
            elif t == "MESSAGE" and sid:
                msgs_by_sid[sid].append(row)
            elif t == "SUGGESTIONS":
                raw = dynamo_unwrap(parse_maybe_json(row.get("items")) or [])
                for s in (raw or []):
                    if isinstance(s, dict) and sval(s.get("question")):
                        suggestions.append({"question": str(s["question"]),
                                            "count": num0(s.get("count"))})

    sessions, messages = [], []
    for sid in (set(metas) | set(msgs_by_sid)):
        mrows = msgs_by_sid.get(sid, [])
        turn_ts, in_tot, out_tot, escalated = [], 0, 0, False
        sid_messages = []
        for m in mrows:
            it, ot = num0(m.get("inputTokens")), num0(m.get("outputTokens"))
            in_tot += it; out_tot += ot
            if as_bool(m.get("escalation")):
                escalated = True
            ts = as_num(m.get("ts"))
            if ts is not None:
                turn_ts.append(ts)
            fb = sval(m.get("feedbackRating"))
            sid_messages.append({
                "sessionId": sid,
                "messageId": sval(m.get("messageId")),
                "question": sval(m.get("question")),
                "answer": sval(m.get("answer")),
                "ts": ts,
                "inputTokens": it, "outputTokens": ot,
                "feedbackRating": fb if fb in ("up", "down") else None,
                "images": None, "imageMode": None,
            })

        meta = metas.get(sid)
        if meta:
            started = sval(meta.get("startedAt")) or (iso_from_ms(min(turn_ts)) if turn_ts else None)
            ended   = sval(meta.get("endedAt"))   or (iso_from_ms(max(turn_ts)) if turn_ts else None)
            dur     = as_num(meta.get("durationMs"))
            qcount  = as_num(meta.get("questionCount"))
            in_m    = as_num(meta.get("inputTokenTotal"))
            out_m   = as_num(meta.get("outputTokenTotal"))
            rating  = sval(meta.get("rating"))
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

        # a session needs a start time to sit on the time axis — drop it and its
        # messages together so the tables/modal never reference an orphan session.
        if not started:
            continue

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
            "_reasons": [str(r) for r in reasons if sval(r)],
        })
        messages.extend(sid_messages)

    reason_counter = Counter()
    for s in sessions:
        for r in s.pop("_reasons", []):
            reason_counter[r] += 1
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
