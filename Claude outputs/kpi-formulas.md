# KPI dashboard — stat & chart formulas

How every number and chart on `kpi.html` is calculated, and which `RBPOCTable`
item/attribute each one comes from. The page computes everything **in the browser**
from two record shapes plus two small lists:

- **session** (one per `SESSION_META` item, `SK = "META"`) — `sessionId`, `startedAt`,
  `endedAt`, `durationMs`, `questionCount`, `rating` (`up`/`down`/`null`), `escalation`
  (rolled up from its messages), `endedBy` (`bot`/`user`), `inputTokenTotal`, `outputTokenTotal`.
- **message** (one per `MSG#<id>` item) — `sessionId`, `messageId`, `question`, `answer`,
  `ts`, `inputTokens`, `outputTokens`, `feedbackRating` (`up`/`down`/`null`).
- **suggestions** — `[{question, count}]` from the single `SUGGESTIONS` item.
- **reasons** — flattened `SESSION_META.reasons` arrays, counted by value.

Notation: `S` = sessions in the selected date range, `M` = their messages.
`pct(n, d) = d ? round(100 · n / d) : 0`.

---

## Helper definitions

| Symbol | Definition |
|---|---|
| `up` / `down` | sessions with `rating === "up"` / `"down"` |
| `rated` | `up + down` (sessions that got a thumb) |
| `mUp` / `mDown` | messages with `feedbackRating === "up"` / `"down"` |
| `mRated` | `mUp + mDown` |
| `esc` | sessions with `escalation === true` |
| `botEnded` | sessions with `endedBy === "bot"` |
| `inTok` / `outTok` | `Σ S.inputTokenTotal` / `Σ S.outputTokenTotal` |

---

## Cards (stat tiles)

| Card | Formula | Source |
|---|---|---|
| **Total sessions** | `S.length` | count of `SESSION_META` |
| **Total messages** | `Σ (questionCount · 2)` — one user + one bot bubble per turn | `SESSION_META.questionCount` |
| **Questions answered** | `Σ questionCount` | `SESSION_META.questionCount` (= count of `MSG#` items) |
| ↳ avg per session | `totalQuestions / totalSessions` | — |
| **Avg session length** | `Σ durationMs / totalSessions`, shown as `Xm Ys` | `SESSION_META.durationMs` |
| **Session CSAT** | `pct(up, rated)` | `SESSION_META.rating` |
| **Answer helpfulness** | `pct(mUp, mRated)` | `MSG#.feedbackRating` |
| **Messages rated** | `mRated` | `MSG#.feedbackRating` |
| ↳ participation | `pct(mRated, M.length)` | — |
| **👍 Helpful** | `mUp` | `MSG#.feedbackRating === "up"` |
| **👎 Needs review** | `mDown` | `MSG#.feedbackRating === "down"` |
| **Bot-resolved** | `pct(botEnded, totalSessions)` | `endedBy` (derived) |
| **Escalation rate** | `pct(esc, totalSessions)` | any `MSG#.escalation === true` |
| **Total tokens** | `inTok + outTok` | `SESSION_META.inputTokenTotal` + `outputTokenTotal` |
| **Est. cost (range)** | `inTok/1e6 · PRICE_IN_PER_M + outTok/1e6 · PRICE_OUT_PER_M` | tokens × price constants |
| **Avg cost / session** | `totalCost / totalSessions` | — |

**Pricing constants** (edit in `kpi.html` to match your model's published USD-per-million rates):
`PRICE_IN_PER_M = 3.00`, `PRICE_OUT_PER_M = 15.00`.

---

## Charts

| Chart | What it plots | Formula |
|---|---|---|
| **Sessions over time** (bar) | sessions per day | group `S` by `startedAt[0:10]`, count each day |
| **Questions asked over time** (line) | questions per day | group `S` by day, `Σ questionCount` |
| **Session satisfaction (CSAT)** (doughnut) | 👍 / 👎 / no-rating split | counts of `rating === "up"`, `"down"`, `null` |
| **Per-message feedback** (bar) | 👍 vs 👎 answers | `mUp`, `mDown` |
| **Token usage over time** (stacked bar) | input vs output tokens per day | group by day, `Σ inputTokenTotal` and `Σ outputTokenTotal` |
| **Top suggestion clicks** (horizontal bar) | most-clicked suggested questions | `suggestions` sorted by `count` desc |
| **Why answers were unhelpful** (horizontal bar) | reason frequency | count each value across `SESSION_META.reasons` |
| **Session duration distribution** (bar) | sessions per length bucket | bucket `durationMs/60000` into `0–1m, 1–2m, 2–3m, 3–5m, 5m+` |

---

## Tables

| Table | Rows | Notes |
|---|---|---|
| **Recent sessions** | one per session in `S` | paginated (10/page); filterable by id, date range, CSAT, escalation, ended-by. Cost column = `costOf(inputTokenTotal, outputTokenTotal)`. |
| **Answer feedback log** | one per message in `M` | paginated (10/page); filterable by question text, session, and rating (`All` / 👍 up / 👎 down / no rating). |

---

## Derived fields (not stored verbatim in DynamoDB)

- **`escalation` (session level)** — the table stores `escalation` **per message**;
  a session is escalated if **any** of its `MSG#` items has `escalation === true`.
- **`endedBy` / Bot-resolved** — the table does not record who ended a chat. Heuristic:
  `endedBy = "user"` if the session escalated, else `"bot"`. To make this exact, add an
  `endedBy` attribute on the `SESSION_META` write in the API Lambda; it then flows through unchanged.
- **Sessions with no `SESSION_META`** (user never ended/rated) — rebuilt from their `MSG#` rows:
  `startedAt/endedAt` = min/max `ts`, `durationMs` = max−min, `questionCount` = message count,
  token totals = summed per-message tokens, `rating` = `null`.
