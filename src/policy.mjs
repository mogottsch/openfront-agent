import {
  actionCriteria,
  buildActions,
  modelState,
  validateObservation,
  OBSERVATION_ERROR,
  MAX_ACTIONS,
} from "../web/observation.js";
export { validateObservation, OBSERVATION_ERROR };
export const POLICY_VERSION = "land-strategy-v4.5.1-reference-clock-clarity";

// Only describe facts already in the approved land observation. These notes
// never filter, rerank, resize or replace a model-selected legal action.
function focusedCriteria(clean, state) {
  const criteria = actionCriteria(buildActions(clean));
  const tribes = state.neighbors.filter(
    (n) => n.type === "tribe" && n.can_attack && n.relationship === "unallied",
  );
  const engaged = tribes.filter((n) => n.our_active_attack_troops > 0);
  const engagedIds = engaged.map((n) => n.id).join(", ");
  const focus = state.tribe_focus;
  const progress = focus?.progress;
  const progressFacts = progress ? {
    reference_kind: progress.reference_kind,
    reference_tick_semantics: progress.reference_tick_semantics,
    reference_tiles: progress.reference_tiles,
    current_target_tiles: focus.territory_tiles,
    territory_delta_since_reference: progress.territory_delta_since_reference,
    elapsed_ticks: progress.elapsed_ticks,
    land_intents_emitted: progress.land_intents_emitted,
    last_land_send_percent: progress.last_land_send_percent,
    our_active_attack_troops: focus.our_active_attack_troops,
  } : null;
  const neighbors = new Map(state.neighbors.map((n) => [n.id, n]));
  for (const [key, criterion] of Object.entries(criteria)) {
    if (key === "wait") {
      if (focus) {
        criterion.tribe_focus_context = `Persistent focus is still-alive tribe ${focus.id}. Waiting lets an active, adequately funded attack run and replenishes home reserve; an exhausted stack or disappeared border alone does not prove conquest. If several emitted sends have not finished the tribe and no sufficient push is active, waiting alone may allow the tribe to regrow; compare the offered 10%/20% reinforcement without draining home defense.`;
        if (progressFacts) criterion.focus_progress_facts = progressFacts;
      }
      else if (engaged.length)
        criterion.tribe_focus_context = `Active non-retreating attacks are already underway against bordering tribe IDs ${engagedIds}. Waiting lets them continue and troops regrow; do not open a different front just because wait looks passive.`;
      continue;
    }
    if (!key.startsWith("attack_")) continue;
    if (key.startsWith("attack_wilderness_")) {
      if (focus && !focus.adjacent)
        criterion.tribe_focus_context = `We lost the border with still-alive focused tribe ${focus.id}. Wilderness is offered only as a reconnection path, not permission to abandon that target for another player.`;
      else if (engaged.length)
        criterion.tribe_focus_context = `We are already attacking bordering tribe IDs ${engagedIds}. Finish that tribe before starting another wilderness push.`;
      continue;
    }
    const targetId = Number(
      key.match(/^attack_player_(\d+)_(?:10|20|30|40|50)$/)?.[1],
    );
    const neighbor = neighbors.get(targetId);
    if (!neighbor) continue;
    criterion.target_territory_tiles = neighbor.territory_tiles;
    criterion.target_available_troops = neighbor.troops;
    criterion.our_active_attack_troops_against_target =
      neighbor.our_active_attack_troops;
    if (neighbor.type === "tribe") {
      criterion.tribe_focus_context =
        focus?.id === neighbor.id
          ? "This tribe remains the persistent, still-alive focus, even if its currently observed attack has ended. Finish its conquest before any other target. Wait/regrow if the active commitment looks sufficient; otherwise compare the offered 10% and 20% reinforcements with the post-send home reserve. A larger legal send may help a repeatedly unfinished push but never guarantees conquest."
          : engaged.length
            ? neighbor.our_active_attack_troops > 0
              ? "Already attacking this tribe. Finish its conquest before opening another target. If its committed attack can finish, wait for it; otherwise consider a modest legal reinforcement without exhausting home defense."
              : `Our attacks on bordering tribe IDs ${engagedIds} are unfinished. Do not open a new tribe front; wait or reinforce an existing target if necessary.`
            : "No currently observed active attack on a bordering tribe. This could be a new tribe target, after resolving any prior focus that is no longer observable here.";
      if (focus?.id === neighbor.id && progressFacts) {
        criterion.focus_progress_facts = progressFacts;
        const size = Number(key.match(/_(10|20)$/)?.[1]);
        criterion.focus_send_size_context = size === 10
          ? "Another 10% send is not automatically prudent or effective merely because it preserves more troops now. If previously emitted small sends ended without conquest and the tribe stayed alive or gained territory, compare this option to 20% and wait; earlier send sizes beyond the latest are not known from progress history."
          : "This offered 20% send is within Moritz's tribe cap, not an automatic escalation. If previous pushes have not finished the still-alive tribe and currently active troops look insufficient, consider whether a stronger commitment could finish sooner while preserving adequate home defense; if an existing push looks sufficient or home reserves are exposed, wait instead.";
      }
    } else if (neighbor.type === "nation") {
      criterion.nation_conquest_context = tribes.length
        ? `There are ${tribes.length} attackable bordering tribes left. Do not start a nation attack until all those tribes are conquered. Its current reserve is not its entire territory, defenses or future reinforcements; a small send is not proof of a finish.`
        : "Nation attack only when a complete conquest is credibly achievable, ideally in one send; consider the whole target territory and strength, unknown defenses and lasting hostility. A favorable current-reserve ratio alone cannot establish that.";
    }
  }
  return criteria;
}

export function buildRequest(observation, model = "jev-latest") {
  const clean = validateObservation(observation);
  const state = modelState(clean);
  return {
    model,
    state,
    questions: {
      action: {
        type: "choice",
        instructions: [
          "Choose one offered action to gain territory and conquest gold while preserving a growing army. state.strategy discloses Moritz's user-authored priority gate: engine-legal targets strategically withheld and their reasons. You cannot choose removed actions. Every returned offered Choice is still freshly revalidated and executed if legal, never replaced with another target or amount.",
          "Early-game priorities are being refined: earlier guidance favored wilderness first; Moritz now emphasizes tribe conquest gold. Before focus, prefer a viable weak or contested tribe when its potential conquest-gold payoff outweighs more wilderness, not a tribe send with inadequate reserves. neighbors[].attacked_by_other_humans_or_nations identifies attacks by other humans or nations; our own attacks, retreating forces and other tribes do not qualify. Do not abandon an unfinished focus for them. Wilderness remains an alternative, not a command every decision. An active wilderness push is NOT an automatic reason to wait: use self.active_wilderness_attack_to_available_reserve_ratio and post-send reserve to distinguish a tiny tail from a well-funded push. The percentage is a commitment, not a reserve target.",
          "state.tribe_focus is a still-alive selected tribe: retain it until authoritative death confirmation. Finish that target before starting another tribe, wilderness or player attack; lost-border wilderness reconnection is the explicit exception. Without stored focus, continue an already active tribe rather than open a new front. Against tribes use at most twenty percent. Wait when the existing push looks sufficient; reinforce the same target when needed and safe. An exhausted stack is not conquest.",
          "Read tribe_focus.progress only when present. For first_emitted_land_intent, reference_tick/reference_tiles are the PRE-INFERENCE decision snapshot associated with the first successfully emitted land intent, NOT emission time. For recovered focus they are the first authoritative focus observation. reference_tick_semantics labels this; elapsed_ticks is time since reference observation, not emission or acceptance. territory_delta_since_reference is current tiles minus reference_tiles, NOT change caused solely by our attacks. land_intents_emitted counts emitted intents, not accepted or completed pushes; null means history unknown. last_land_send_percent describes only the latest send. If repeated small sends have not finished the tribe and it persists or grows, compare a legal 20% option with 10% and wait using active force, defender reserve/territory, incoming pressure and post-send home reserve. Controlled engine cases support considering stronger reinforcement, not a universal conquest guarantee. Do not mechanically repeat 10%, automatically escalate, or wait forever; if home defense is thin, regrow. Worker gold or partial territory is not proof of conquest bounty; actual elimination matters.",
          "Take all attackable bordering tribes before attacking any nation. Then attack only if confident we can FINISH conquering the whole nation, ideally in one send; aggression can create lasting, not permanent, hostility. Currently available troops or committed-to-defender ratio do NOT measure total territorial resistance or full-conquest probability. Unknown defenses and reinforcements remain unknown; wait rather than a token nation raid when a credible finish is unsupported.",
          "Under incoming pressure, compare our reserve with the attacker's reserve PLUS its active incoming force via attackers[].our_reserve_is_stronger; consider all attackers. Do not full-send or chain large sends or assume rescue. Top-level attackers threaten us; a neighbor's attackers target that neighbor. Outgoing troops are not home defense. Waiting leaves current attacks running. Counts are display units; ratios/remaining reserves are calculated. No city-defense or encirclement strategy is assumed.",
        ],
        criteria: focusedCriteria(clean, state),
      },
    },
  };
}

export function parseDecision(response, criteria) {
  const answer = response?.answers?.action;
  const keys = Object.keys(criteria ?? {});
  const probability = (n) => Number.isFinite(n) && n >= 0 && n <= 1;
  if (
    keys.length === 0 ||
    keys.length > MAX_ACTIONS ||
    answer?.type !== "choice" ||
    !Object.hasOwn(criteria, answer.choice) ||
    !probability(answer.confidence) ||
    !answer.probabilities ||
    Object.keys(answer.probabilities).length !== keys.length ||
    !keys.every((key) => probability(answer.probabilities[key])) ||
    Math.abs(
      Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1,
    ) > 0.02
  ) {
    throw new Error("Invalid TypeSafe Choice response for the offered actions");
  }
  return {
    action: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    model: response.model,
    usage: response.usage,
  };
}
