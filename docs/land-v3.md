# Land observations and dynamic actions (v3)

2026-09-20 · historical neutral policy `land-observation-v3.1` · OpenFront `bb8af015b`. V3.1 expands commitments to 10/20/30/40/50%; observations and neutral prompt instructions are unchanged. Historical live results below used v3's 10/20% menu. Current local experiment is `land-strategy-v4.1`: additional incoming/outgoing attack records, hard tribe ≤20% ceiling and reviewed land instructions (see [strategy review](strategy-review.html)). The JSON examples below describe the older neutral version, **not** the current v4.1 input schema.

## Experiment scope

The user requested expanded observations and actions **before deriving a new strategy**. Accordingly, v3 removes the v2 reserve thresholds. Its prompt asks Jev to choose an available action to survive and gain territory, and explains the data/action semantics. There is no instruction to prefer wilderness, maintain a particular reserve, wait under pressure, attack the weakest player, or follow an opening sequence.

One Choice contains all current legal target/amount combinations. The harness owns arithmetic, legality, timing, and execution—not which candidate wins.

## Observation contract

The browser sends a strict, bounded raw observation to the local sidecar. This illustrative example is the unit-test fixture, not a live capture:

```json
{
  "self": {
    "id": 1,
    "troops": 2500,
    "troop_capacity": 12000,
    "territory_tiles": 52
  },
  "border": {
    "total_edges": 20,
    "wilderness_edges": 8,
    "player_edges": 8,
    "water_edges": 2,
    "blocked_edges": 2
  },
  "neighbors": [
    {
      "id": 2,
      "type": "tribe",
      "relationship": "unallied",
      "shared_border_edges": 5,
      "troops": 1000,
      "troop_capacity": 5000,
      "territory_tiles": 100,
      "can_attack": true
    },
    {
      "id": 3,
      "type": "human",
      "relationship": "ally",
      "shared_border_edges": 3,
      "troops": 3000,
      "troop_capacity": 12000,
      "territory_tiles": 300,
      "can_attack": false
    }
  ],
  "incoming_attacks": [
    { "id": "incoming1", "attacker_id": 2, "troops": 100, "retreating": false }
  ]
}
```

The shared `web/observation.js` module validates this and computes the **model state**:

- `self.reserve_percent` and `neighbors[].reserve_percent`: `100 × troops / capacity`, rounded to two decimals.
- `troops_per_tile`: available troops divided by territory tiles; null for zero tiles.
- `border.*_share`: category edges / total edges, rounded to four decimals.
- `neighbors[].border_share`: that player's shared edges / total border edges.
- `self.active_incoming_troops`: sum of non-retreating incoming attacks.
- `neighbors[].troops_attacking_us`: the same sum restricted to that attacker.

For the example, our reserve percentage is 20.83%, wilderness share 0.4, player 2's border share 0.25, and active incoming troops 100. These calculations are not delegated to Jev. Unknown extra fields are rejected rather than silently forwarded.

### Border measurement

- Count **cardinal shared edges**, not unique tiles or diagonal contacts. One own tile can contribute several edges to one or several categories.
- Wilderness means adjacent passable, unowned land.
- Water and impassable land are separate from attackable land. `blocked_edges` also includes outward map-boundary edges.
- Counts come from the worker's border-tile set, checked against current `GameView` ownership. Map-perimeter edges are scanned separately because the core border set omits edges with no in-map neighboring tile.
- Sum of neighbor shared edges must equal `player_edges`; all four categories must sum to `total_edges`. Shares are of the entire border, including coast/blocked edges—not only land contacts.
- Only directly bordering players are included, not the full roster. Incoming attacks may reference a player outside that list, e.g. a border that has since changed.

### Player identities and troop units

IDs are the simulation's numeric `smallID`, stable within a match. The adapter resolves them back to current `PlayerView.id()` strings before emitting an attack intent. Display units divide internal troops by ten and round down; very small/negative transient attack balances are clamped to zero. Capacity uses the real game rule, including player type, territory and buildings.

Relationships are teammate, ally or unallied; unallied is not a claim about a nation's internal diplomatic attitude. `can_attack` comes from the real worker's `PlayerActions.canAttack`, not a strength heuristic. Friendly players are excluded even if a special game rule would otherwise permit an attack on a disconnected teammate.

## Action contract

The example now produces eleven choices:

```text
wait
attack_wilderness_10
attack_wilderness_20
attack_wilderness_30
attack_wilderness_40
attack_wilderness_50
attack_player_2_10
attack_player_2_20
attack_player_2_30
attack_player_2_40
attack_player_2_50
```

Player 3 is an ally and receives no attack choices. With no wilderness, the five wilderness choices disappear. If a player is immune or otherwise not attackable, their choices disappear. If the available pool cannot fund even one internal troop, that attack option is omitted. The former `attack_0` duplicate is collapsed into wait.

Each attack's criterion describes its target, percentage of **available troops**, estimated commitment, estimated remaining reserve, and committed-force/defender ratio. In the example, attacking player 2 with 20% means an estimated 500 troops, leaving 2000; the comparison ratio is 0.5, **not** the whole-army ratio of 2.5. The ratio is null for wilderness or a zero defender pool.

Candidate estimates describe the snapshot. At execution, the chosen percentage is applied to the then-current internal troop pool. The model cannot invent another target, arbitrary coordinates, a larger percentage, a boat, or a building.

Bounds are explicit: up to 126 observed neighbors, 256 incoming attack records, and 64 KiB raw HTTP bodies. A separate candidate-count guard enforces TypeSafe's 255-option maximum. Five amounts per target permit 50 attack targets including wilderness (251 choices with wait), so 49 attackable players fit when wilderness is available, or 50 without wilderness. Non-attackable neighbors consume observation space but no action slots. Oversized states or candidate sets fail; no silent top-k selection hides neighbors.

## Freshness, legality, and no-op behavior

Observation and legality queries cross the simulation-worker boundary asynchronously. The snapshot records a tick; the controller rejects observations/replies older than two seconds or 20 ticks. Before execution, the adapter gets current border tiles, checks current ownership and friendship, and calls the worker's legality query again. A single-use permit binds that check to the target, fraction, tile and current tick. Execution resolves the current game ID and sends the normal `SendAttackIntentEvent`.

This is not an execution guarantee: a valid intent can become obsolete before the simulation applies it. The panel therefore reports **intent sent**, not confirmed conquest.

No legal attack candidates means wait is the only possible action. The harness polls locally without spending a model call and can resume when immunity expires or borders change. A target becoming invalid after inference causes a discard, not an automatic substitution. Cadence remains one second, single-flight, with no catch-up queue. Session lifecycle, limits and pause/death handling remain active.

## Live validation

Real `jev-1.13.0` calls in a local Europe **Compact** solo game, Easy, 400 tribes, five nations, random spawn. No manual attacks or model-choice overrides.

### Opening: 30 decisions

- All 30 choices were **10% wilderness attacks**; all 30 were emitted as normal land attack intents.
- Neighbor count grew from zero to two. Neighbor attack choices were present from decision 6 onward; Jev still chose wilderness.
- The last queried state had 6,561 owned tiles, 4,957 reserve troops and 49,013 capacity. Border: 117 wilderness edges, 105 player edges, 230 water edges, zero blocked edges.
- That state included two unallied tribes (IDs 71 and 85), their respective troop counts/capacities/territories, and computed shares and strength ratios. No incoming attacks were present during this phase.
- API latency averaged 308 ms, median 254 ms, maximum 1190 ms. The slow call did not overlap another request.
- Maximum browser-observed in-flight count was one; the controller stopped at its 30-call cap.

### Separate continuation: ten decisions

The same match was resumed **after an idle interval of roughly two and a half minutes**, while the game continued without new bot orders. This is not a continuous 40-decision opening or a controlled performance comparison.

- Started with three neighbors, an active incoming attack, and reserves near capacity.
- Jev chose **six waits**, then **20% against player 104**, **10% wilderness**, **20% against player 19**, and **20% against player 85**.
- Incoming attack records were present during the six waits. After they disappeared, the observed choices changed. This is a description of the sequence, not proof of why Jev chose it.
- All four selected attack intents were emitted. The game visibly showed active attacks on neighboring players (including York Dynasty and Polish Federation), and owned territory increased during the follow-up.
- Candidate lists changed as borders changed, including decisions without any wilderness options.
- Maximum in-flight count remained one; the controller stopped at the ten-call cap.

This validates both wilderness and player-target plumbing and demonstrates unguided choices in two situations. It does not establish a strong strategy, win rate, or causal effect of any one input feature.

Raw local evidence is ignored under `logs/`: `land-v3-first-browser-evidence.txt`, `land-v3-browser-evidence.txt`, and `decisions-2026-09-20T14-29-37.474Z.jsonl` (first 30 rows = opening, next ten = continuation). Inference records include the exact model state and candidate descriptions. Browser evidence separately includes concurrency and panel outcomes.

## Automated checks

- Border edges vs tiles, no diagonal neighbors, map-perimeter accounting, player/terrain categories.
- Strict schema, derived ratios and incoming totals, zero denominators, duplicate IDs, bounds and no friendly choices.
- Dynamic response membership: fabricated targets, stale/allied targets and unsupported percentages cannot execute.
- Worker revalidation, target-ID translation, current internal troop amounts, single-use legality permits.
- No-wilderness player attacks, wait-only polling, cancellation, freshness, and unchanged one-second single-flight scheduling.
- A below-reserve player attack selected by the model is executed when legal: no hidden reserve policy remains.
- Upstream TypeScript and targeted client tests pass.

These tests use mocks for unit boundaries; the live sequences above are separate real-API/gameplay checks.
