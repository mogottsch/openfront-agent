# v4.6: source-backed native win context

## Scope, not a new action rule

The [complete v4.5.3 Easy loss](hybrid-easy-v4.5.3-full-match.md) honored 283 waits and reached a real Switzerland timer win. It does **not** prove why Jev waited. The next small source slice exposes the **actual victory condition, engine clock and complete current territory standings summary**; it does not change any gate, menu, send size, arithmetic or returned wait.

Source versions: `land-strategy-v4.6-win-context`, `hybrid-branch-v4-win-context`. Optional raw `win_context` is produced by `web/win-context.js`, shared by browser/core observers, strictly cloned/validated by `web/observation.js`, and passed through both direct-land and hybrid model state at **`state.win_context`**. This is a native game-rule context, **not an authoritative Copilot objective**. Runtime version still requires an explicit sidecar restart/health check after publication.

## Actual native facts

`WinCheckExecution` unranked FFA sorts **all alive players** by owned tiles. BOT tribes are eligible; stats/HUD exclusions do not change eligibility. A largest alive player wins after strict land-share threshold, configured timer or the **170-minute/10,200-second hard limit**. Stable-sort tie ordering matters: a competition-rank1 tie does not promise our winner. Actual Win update remains authority.

Both actual core and GameView `elapsedGameSeconds()` measure simulation ticks since the actual spawn-phase end, divided by10. It is **not raw tick/10, wall time, controller Start time or request count**. Configured `maxTimerValue` is minutes; null/undefined means timer OFF only when the config API is genuinely available. Timer OFF is not unlimited: hard limit still applies. The configured share threshold is read for actual elapsed time and can change through overtime to **zero**. Native share uses strict cross multiplication, not `>=`.

Producer scope initially requires actual **Singleplayer**, **Free For All**, no rankedType and `config.isReplay()===false`. Team, ranked, multiplayer or OpenFront Replay UI context is not approximated as Solo. Missing API, malformed live record, absent self, oversized registry, frame/identity/rule mismatch means the entire optional field is **absent/unknown**, never elapsed0, timer-off, rank1 or truncated complete coverage.

The collector reads the documented complete player registry, explicitly filters authoritative `isAlive()===true` on BOTH core and GameView (core.players is alive-only; GameView.players includes dead), retains all three types, and validates unique IDs/identities. Two synchronous complete player passes with bounded ID sorting (up to4095 records), plus owning tick/game/self checks detect coherence changes. No map scan, geometry, worker query, timer, intent or provider call occurs. Complete source-registry API semantics are required; a sampled facade must not be substituted.

## Exact genuine-engine MOCK sample

C created one fresh actual native Europe training world, compared **full core observation == GameAdapter on a truthful GameView-shaped facade**, and then ran three explicitly **MOCKED** wilderness10% choices. No HTTP/provider call or real model judgment occurred. This is actual getter/engine parity, not actual Chrome cadence or a win.

At reported tick3 the exact raw field was:

```json
{
  "game_id": "europe-focus-001",
  "source_tick": 3,
  "rule": "ffa_largest_alive_territory_at_timer_or_strict_share",
  "elapsed_seconds": 0.2,
  "timer_seconds": 300,
  "share_threshold_percent": 80,
  "non_fallout_land_tiles": 568335,
  "eligible_alive_count": 16,
  "self_rank_by_tiles": 1,
  "leading_territory_tiles": 52,
  "tied_leader_count": 15,
  "leader": null
}
```

Raw ticks/10 would wrongly give0.3. The complete registry has16 alive participants, including BOT tribes. Fifteen share the maximum52 tiles; `leader:null` deliberately avoids inventing a unique winner. Competition rank is **1+count with strictly more tiles**.

Derived model state adds configured time remaining299.8s, hard deadline10200s, effective time remaining299.8s, land deficit0, eligible types, explicit rank/tie semantics, own share0.0091% and strict predicatefalse. It does not declare victory.

The three mock normal turns4/12/22 grew52→326 tiles, final31/3s/gold2900, no City/Win/censored cap. Ignored evidence: `logs/benchmark-europe-v46-win-context-mock3.json`, wrapper `{parity,report}`. Historical20/160/300 actual replies/results remain unchanged and tagged4.5.3; that initial source/API check had no real v4.6 judgment. A later [real20 opening](focus-easy-v4.6-validation.md) separately verified actual request delivery and tribe conquest, not deadline pressure or victory.

## Strict and unknown-aware details

- Exact raw12-key shape; extra instructions/code, invalid timer minutes, nonfinite values, inconsistent rank/leader/ties or known neighbor contradiction are rejected. Leader `{id,type}` only for a unique maximum; null for ties.
- Source tick matches known neighbor inventory tick and the owning Hybrid snapshot; game ID matches Hybrid ID. Core uses the existing read-only actual game-ID facade, not a mutation of native state.
- Configured/hard deadline, remaining engine seconds, land deficit and share math are code-derived. Share percentage is null at denominator0, but the **native cross-product predicate remains defined**, not null. The predicate is not an emitted Win or future guarantee.
- With context present, hybrid City construction seconds are derived from configured simulation ticks/10, allowing comparison with remaining engine time. Even a synthetic City that finishes after the deadline remains offered/parseable; **no hidden City veto**.
- Goal instructions are conditional. Legacy instructions/criteria remain unchanged when the optional field is absent. All offered wait/save_gold/land/City answers remain valid. Being behind, tied or near a deadline neither authorizes withheld actions nor proves a conquest feasible.
- Frozen late2991 **local** facts come from the actual full match; added global leader/rank/deadline overlays in tests are explicitly **synthetic**. Final3011 Switzerland86,809 is never backdated as a measured2991 leader.

## Validation and next evidence

Dependency-free tests cover BOT leaders, dead-player filtering, actual spawn-offset clock, Replay/unsupported/missing/budget unknowns, frame/identity changes, timer-off+hard limit, dynamic threshold0, strict equality, denominator0, raw clone, rank/tie coherence, browser/core parity, exact City/land candidate membership and honored waits. A real-model opening/full match is a **separate explicitly bounded next experiment**, not something this mocked source/API check already proves.

The strongest-bot goal is still unmet: no completed Easy/higher Jev victory. Full-target terrain and contact reachability remain future observation slices, not deployed conquest predictions. Copilot stays disabled without its explicit server-only token; no ambient credential retry or validated plan. Keep generated logs and credentials out of Git.
