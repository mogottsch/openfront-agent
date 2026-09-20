# Reserve-v2: real model and live game validation

2026-09-20 · `jev-1.13.0` via `jev-latest` · historical policy `wilderness-reserve-v2` (commit `1398be8`). Current [v3](land-v3.md) expands the state/actions and deliberately removes the reserve strategy.

## What changed

Jev now receives exactly two game-state fields, both in displayed troop units:

```json
{ "troops": 3900, "troop_capacity": 12000 }
```

The bridge obtains capacity from OpenFront's real `Config.maxTroops(player)` and divides both values by ten, rounding down. No ratio, target action, history, enemies, map, or ongoing attacks are added to the model state. The panel can calculate a reserve percentage for the human observer; that derived percentage is not sent to Jev.

The prompt targets a reserve near 30% of capacity and defines explicit choice conditions:

- Reserve at or below 31.6%: wait (0% has the same effect).
- Above 31.6%, up to 35.3%: attack with 10% of available troops.
- Above 35.3%: attack with 20% of available troops.

The paragraph describes the decision, not the harness cadence. The harness still controls one-second request pacing, single-flight, staleness checks, lifecycle, and normal attack-intent execution. **It does not compute and substitute an action from the reserve rule.**

## Fixed-observation probes — not a game

Three real API requests first tested a paragraph with generic action descriptions. Jev chose wait in all three, matching only the low-reserve case. The conditions were then repeated explicitly in the option descriptions, without changing the inputs or thresholds:

| Troops | Capacity | Reserve | Expected   | Jev after explicit option conditions |
| -----: | -------: | ------: | ---------- | ------------------------------------ |
|  2,500 |   12,000 |  20.83% | wait       | wait                                 |
|  3,900 |   12,000 |  32.50% | attack 10% | attack 10%                           |
|  5,000 |   12,000 |  41.67% | attack 20% | **wait**                             |

The final probe failed with confidence 0.55 (`wait` probability 0.66). This is evidence of unreliable numerical policy following, not a transport error. It does not establish whether division, comparing ranges, or competing prompt semantics is the cause.

To repeat a paid probe against the historical v2 checkout (`1398be8`) and its matching bridge/sidecar—not the current v3 schema:

```bash
curl http://127.0.0.1:8788/decision \
  -H 'Content-Type: application/json' \
  -d '{"troops":3900,"troop_capacity":12000}'
```

These probes use supplied observations. They are separate from the live test below.

## Live local game — actual model control

A fresh Europe solo match, Easy, 10 tribes, five nations, random spawn. One-second interval and a 30-request cap. All actions came from real Jev responses; no manual attacks or reference-policy overrides were used.

- **30 successful requests**, maximum **one in flight**, zero pending at completion.
- Browser-observed request-start gaps: **1004–1019 ms**.
- Sidecar-recorded upstream request-start gaps: **1004–1021 ms**.
- API latency: **251 ms mean**, **234 ms median**, **196–604 ms range**.
- **23 waits, five 10% attacks, two 20% attacks**.
- The panel recorded **seven wilderness intents sent** and **23 no-ops**. Territory visibly expanded.
- First attack: fifth decision, about four seconds after starting the controller, at **3,987 / 12,141 troops (32.84%)**.
- Last queried state: **11,491 / 37,970 troops (30.26%)**, with choice wait. The game continued after the controller stopped, so this is not a later frozen end-of-game balance.
- Controller stopped at the 30-request cap.

### Adherence to the specified ranges

**24/30 answers matched (80%)** in this one run. This is not a population accuracy estimate or proof of strategic quality. All six disagreements were waits where the stated rule called for a 10% attack:

| Decision | Troops | Capacity | Reserve | Expected   | Actual |
| -------: | -----: | -------: | ------: | ---------- | ------ |
|        8 |  4,777 |   14,673 |  32.56% | attack 10% | wait   |
|       11 |  5,603 |   17,519 |  31.98% | attack 10% | wait   |
|       17 |  7,454 |   23,449 |  31.79% | attack 10% | wait   |
|       20 |  8,501 |   26,319 |  32.30% | attack 10% | wait   |
|       21 |  9,186 |   26,528 |  34.63% | attack 10% | wait   |
|       26 | 10,702 |   32,237 |  33.20% | attack 10% | wait   |

The comparison is made against the **queried** state, not the later state when a response executes. Thus these disagreements are not explained by troops regenerating during API latency.

The broad behavior changed in the intended direction: early waiting, smaller expansion sends, and reserves usually near the target after the initial buildup. But the precise numeric policy is not reliably enforced by Jev. At this point, a proposed next experiment was to supply a reserve percentage calculated in code. V3 now supplies that derived feature as part of a larger border/neighbor observation, but removes the numeric reserve strategy; it is not a controlled test of whether the ratio alone improves adherence.

## Evidence and tests

Raw local artifacts are ignored rather than published:

- `logs/reserve-v2-probes.json`: initial generic-option probes.
- `logs/reserve-v2-probes-criteria.json`: explicit-option probes, including exact requests.
- `logs/decisions-2026-09-20T13-42-07.800Z.jsonl`: the final 30 live requests and model responses.
- `logs/reserve-v2-live-summary.json`: adherence and timing summary.
- `logs/reserve-v2-browser-evidence.txt`: browser timing, responses, and panel outcomes.

Automated tests check exact two-field projection, capacity validation, no extra state, cadence, cancellation, bounded execution, and that a model choice is not replaced by the reserve heuristic. Those tests use mocks and are **not** evidence of model accuracy. Upstream TypeScript and targeted client tests also pass. The live test above provides separate evidence of real inference and game control.
