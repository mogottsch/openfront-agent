import test from "node:test";
import assert from "node:assert/strict";
import { observeWinContext, validateWinContext, deriveWinContext, WIN_RULE } from "../web/win-context.js";

const self = {id:1,territory_tiles:52};
const context = () => ({game_id:"solo-test",source_tick:100,rule:WIN_RULE,
  elapsed_seconds:3,timer_seconds:300,share_threshold_percent:80,
  non_fallout_land_tiles:10000,eligible_alive_count:3,self_rank_by_tiles:3,
  leading_territory_tiles:500,tied_leader_count:1,leader:{id:2,type:"tribe"}});
const player = (id,type,tiles,alive=true) => ({smallID:()=>id,id:()=>`p${id}`,
  type:()=>type,numTilesOwned:()=>tiles,isAlive:()=>alive,isPlayer:()=>true});
function fixture(){
  const state={tick:100,elapsed:3,gameId:"solo-test",replay:false,wall:0};
  const setting={gameType:"Singleplayer",gameMode:"Free For All",maxTimerValue:5};
  const players=[player(1,"HUMAN",52),player(2,"BOT",500),player(3,"NATION",200),
    player(4,"NATION",99999,false)];
  const config={gameConfig:()=>setting,isReplay:()=>state.replay,
    percentageTilesOwnedToWin:()=>80};
  const game={ticks:()=>state.tick,gameID:()=>state.gameId,config:()=>config,
    elapsedGameSeconds:()=>state.elapsed,numLandTiles:()=>10000,numTilesWithFallout:()=>0,
    players:()=>players,playerBySmallID:id=>players.find(p=>p.smallID()===id)};
  return {game,state,setting,players,config};
}

test("all authoritative alive types, including BOT; exclude dead views; complete compact facts",()=>{
  const {game}=fixture();assert.deepEqual(observeWinContext(game,1),context());
  // Client.players includes dead, core.players filters alive: same summary.
  const core={...game,players:()=>game.players().filter(p=>p.isAlive())};
  assert.deepEqual(observeWinContext(core,1),observeWinContext(game,1));
});
test("actual elapsed API not rawticks/wall/controller-start; configured and hard deadlines",()=>{
  const {game,state,setting}=fixture();
  state.wall=9e9;assert.equal(observeWinContext(game,1).elapsed_seconds,3); // NOT100/10
  const derived=deriveWinContext(observeWinContext(game,1),self);
  assert.equal(derived.configured_timer_remaining_seconds,297);
  assert.equal(derived.effective_deadline_remaining_seconds,297);
  assert.equal(derived.territory_tiles_behind_leader,448);
  setting.maxTimerValue=null;
  const off=deriveWinContext(observeWinContext(game,1),self);
  assert.equal(off.configured_timer_remaining_seconds,null);
  assert.equal(off.effective_deadline_seconds,10200);
  assert.equal(off.effective_deadline_remaining_seconds,10197);
  delete setting.maxTimerValue;assert.equal(observeWinContext(game,1).timer_seconds,null);
});
test("unique leader, co-leading competition rank, and expired time are not winner promises",()=>{
  const c=context();c.self_rank_by_tiles=1;c.leading_territory_tiles=52;
  c.tied_leader_count=2;c.leader=null;c.elapsed_seconds=301;
  const d=deriveWinContext(c,self);
  assert.equal(d.effective_deadline_remaining_seconds,0);
  assert.equal(d.self_rank_by_tiles,1);assert.equal(d.leader,null);
  assert.equal(d.territory_tiles_behind_leader,0);
  assert.equal(Object.hasOwn(d,"win"),false);
  c.tied_leader_count=1;c.leader={id:1,type:"human"};
  assert.equal(validateWinContext(c,self).leader.id,1);
  const f=fixture();f.players[1]=player(2,"BOT",52);f.players[2]=player(3,"NATION",52);
  const actual=observeWinContext(f.game,1);
  assert.equal(actual.self_rank_by_tiles,1);assert.equal(actual.tied_leader_count,3);
  assert.equal(actual.leader,null);
});
test("dynamic threshold allows native overtime zero; strict equality not exceeded",()=>{
  const c=context();c.non_fallout_land_tiles=65; //52/65 exactly80%
  assert.equal(deriveWinContext(c,self).our_territory_share_percent,80);
  assert.equal(deriveWinContext(c,self).our_share_exceeds_threshold,false);
  c.non_fallout_land_tiles=64;
  assert.equal(deriveWinContext(c,self).our_share_exceeds_threshold,true);
  c.non_fallout_land_tiles=0;
  const zero=deriveWinContext(c,self);
  assert.equal(zero.our_territory_share_percent,null);
  assert.equal(zero.our_share_exceeds_threshold,true); // native defined crossproduct
  const f=fixture();f.config.percentageTilesOwnedToWin=()=>0;
  assert.equal(observeWinContext(f.game,1).share_threshold_percent,0);
});
test("strict clone and cross-self rank/leader/tie consistency; no code/instructions",()=>{
  const c=context();const cloned=validateWinContext(c,self);
  c.leader.type="nation";assert.equal(cloned.leader.type,"tribe");
  const edits=[c=>c.extra="execute",c=>c.game_id="",c=>c.source_tick=-1,
    c=>c.elapsed_seconds=NaN,c=>c.timer_seconds=30,c=>c.timer_seconds=7201,
    c=>c.share_threshold_percent=-1,c=>c.non_fallout_land_tiles=-1,
    c=>c.self_rank_by_tiles=1,c=>c.leading_territory_tiles=51,
    c=>c.tied_leader_count=4,c=>c.leader=null,c=>c.leader.id=1,
    c=>c.leader.type="unknown",c=>{c.tied_leader_count=2;c.leader=null;c.self_rank_by_tiles=2;}];
  for(const change of edits){const raw=context();change(raw);assert.throws(()=>validateWinContext(raw,self));}
  assert.throws(()=>validateWinContext(context(),{id:1,territory_tiles:0}));
});
test("unsupported/missing APIs, Replay, teams/ranked and incomplete self registry remain unknown",()=>{
  const modes=[f=>f.setting.gameType="Public",f=>f.setting.gameMode="Team",
    f=>f.setting.rankedType="1v1",f=>f.state.replay=true,
    f=>delete f.config.isReplay,f=>delete f.game.elapsedGameSeconds,
    f=>delete f.game.gameID,f=>delete f.config.gameConfig,
    f=>f.game.players=()=>f.players.slice(1),f=>f.game.players=()=>Array(4096).fill(f.players[0]),
    f=>f.players[1]=player(2,"UNKNOWN",500),f=>f.players[1]={...f.players[1],isAlive:()=>undefined},
    f=>f.players.push(f.players[1]),f=>f.players[0]=player(1,"BOT",52)];
  for(const change of modes){const f=fixture();change(f);assert.equal(observeWinContext(f.game,1),undefined);}
});
test("expected tick, identity, registry or snapshot changes are absent instead of relabeled",()=>{
  const f=fixture();assert.equal(observeWinContext(f.game,1,{expectedTick:99}),undefined);
  let calls=0;f.game.players=()=>{if(++calls===2)f.state.tick++;return f.players;};
  assert.equal(observeWinContext(f.game,1),undefined);
  const g=fixture();g.game.elapsedGameSeconds=()=>{g.state.gameId="changed";return 3;};
  assert.equal(observeWinContext(g.game,1),undefined);
  const h=fixture();let reads=0;
  h.game.players=()=>{if(++reads===2)h.players[1]=player(2,"BOT",501);return h.players;};
  assert.equal(observeWinContext(h.game,1),undefined);
});
