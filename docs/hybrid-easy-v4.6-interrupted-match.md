# v4.6 full-match attempt interrupted: no game outcome

## Recorded boundary

The explicitly authorized fresh300-call maximum v4.6 training match **did not complete**. The retained report `logs/jev-hybrid-europe-easy-v46-full300.json` records:

- **22 local attempts**, **21 successful structured replies**, then generic `Decision failed/timed out; no retry` at captured tick211.
- `status:"censored-decision-error"`, `complete:false`, `win:null`, zero Win events. **Not a Human loss or a completed300-response match.**
- Human alive at **tick211 /21 game seconds**, **2,861 tiles**, **67,416 internal troops**, **27,050 gold**, zero Cities.
- Finally Stop was attempted but **revocation was not confirmed**: `revoked:false`, `stop_error:"Local Stop failed; no retry"`.

No failed Choice was replaced, no extra native step was executed for the failed22nd decision, and no automatic request/Stop retry occurred. The underlying error cause is **not established** by this report; it must not be labeled HTTP529, quota, timeout, crash or a gameplay/strategy defeat.

## Exact evidence slice, not aggregate log counts

The retained sidecar `logs/decisions-2026-10-03T13-55-18.139Z.jsonl` has **282 rows**, containing multiple games. The separate [short20](focus-easy-v4.6-validation.md) occupies its first20 rows. This interrupted attempt's **21 exact matching successful records are 1-indexed rows120..140** (zero-index119..139), timestamps **2026-10-03T14:22:35.424Z..14:22:58.519Z**. They are not simply the21 rows immediately after the first20.

C deep-compared those21 full offered requests and actual replies, including confidence, probabilities, usage and latency; all were `jev-1.13.0`, non-probe, with no plan provenance. Other game IDs in the log are **not this experiment**, cannot be added to its paid-call count, and do not establish its failure cause.

The failed22nd offered request has **no matching successful JSONL row anywhere** and no `model_reply`. This logger records successful replies, so absence does **not** prove the server never received the request or the provider was never called. Distinguish22 local attempts,21 verified real replies, and an unverified final attempt.

Artifact SHA256 begins `7f7b3a` and ends `8772537`; original artifact and short20 remain unchanged. Generated logs stay ignored.

## Actual choices and engine events

All22 captured input snapshots had valid, same-game/same-tick raw12-field Win context, native spawn-offset elapsed time and exact derived deadline/rank/share facts. The failed snapshot had **279 engine seconds remaining**; this run never tested late deadline pressure.

The21 successful choices were **13 waits** and **eight normal land attacks**: wilderness10%×2, wilderness20%×3 and tribe11 20%×3. Every returned wait was honored; every emitted target/fraction/stamped turn matched its offered choice. Actual core reserve and integer rounding were used, not post-answer resizing.

**ConquestEvent125:** our Human `2wiw51xq` conquered tribe `k62i96c9`, **6,150 gold**. No premature front, nation attack, City/Post/boat build or Copilot action was observed.

Gold reconciles exactly: `100 initial +208 native ticks×100 ordinary income +6,150 conquest =27,050`.

Successful capture ages **215.389..322.796ms**, maximum final submission **322.804ms**; minimum request-start spacing **1,001.835ms**, native ticks **100.009ms**, serial single-flight. Those successful-response timing facts do not explain the failed final attempt.

## Later local-service restoration is not retrospective causality

When A resumed on **2026-10-17**, the current host reported a boot at08:20 and port8788 had no listening sidecar; old `/tmp` logs were unavailable. This later state does **not establish what failed on October3**.

A checked for duplicates and restored the sidecar **idle only**, verified land4.6/hybridv4, `requiresStart:true`, `sessionActive:false`, planner disabled. Startup/health checks made no model request and did not resume/retry the stopped match. Current idle health is not evidence the original Stop successfully revoked its historical token.

420 dependency-free tests pass on the retained source. No completed v4.6 match, deadline-pressure result or Easy/higher Jev victory is established. The earlier real City and completed Switzerland loss remain separately tagged4.5.3. Any further paid experiment requires a new explicit bounded Start; this interrupted artifact is not an automatic rerun authorization.
