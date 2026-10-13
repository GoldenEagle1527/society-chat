const fs = require('fs');
const path = require('path');
const ROOT = process.env.OBS_ROOT || path.join(__dirname);
const POLL = path.join(ROOT, '_obs15_poll.jsonl');
const GONE = path.join(ROOT, '_obs15_gone_tick.txt');
const READY = path.join(ROOT, '_obs15_dump_ready.txt');
const WORLD = path.join(ROOT, 'data', 'society', 'world.json');
const TARGET_N = 100;
const STALL_FLAT_TICKS = 800; // flat fruit ≥800 ticks with fb→0 → honest STALL
const MAX_WALL_MS = 720 * 60 * 1000;
const INTERVAL_MS = 12000;

function readWorld() {
  return JSON.parse(fs.readFileSync(WORLD, 'utf8'));
}

function countEvents(ev) {
  const c = {
    cok: 0, clBite: 0, fruitBite: 0, death: 0, wipeout: 0,
    revive: 0, revived: 0, hungryRevive: 0, deathTopped: 0,
    pull: 0, adsorb: 0, catalyze: 0, clutter: 0, starving: 0, hungryBite: 0,
    catalyzeMaxed: 0, prepRefuse: 0,
    prepRefuseMove: 0, prepRefusePull: 0, prepRefuseBite: 0, prepRefuseOther: 0,
    fruitForageRefuse: 0, hungryMove: 0, wait: 0, move: 0, satiated: 0,
  };
  for (const e of ev || []) {
    if (e.type === 'condense') c.cok++;
    else if (e.type === 'bite' && e.payload?.kind === 'clump') {
      c.clBite++;
      if (e.payload?.hungry_clump_bite) c.hungryBite++;
    } else if (e.type === 'bite' && e.payload?.kind === 'fruit') c.fruitBite++;
    else if (e.type === 'death') {
      c.death++;
      if (e.payload?.topped_from_waste) c.deathTopped++;
    } else if (e.type === 'wipeout') c.wipeout++;
    else if (e.type === 'revive') c.revive++;
    else if (e.type === 'revived') {
      c.revived++;
      if (e.payload?.hungry_revive) c.hungryRevive++;
    } else if (e.type === 'pull') c.pull++;
    else if (e.type === 'adsorb') c.adsorb++;
    else if (e.type === 'catalyze') c.catalyze++;
    else if (e.type === 'wait') c.wait++;
    else if (e.type === 'move') {
      c.move++;
      if (e.payload?.hungry_move) c.hungryMove++;
    } else if (e.type === 'refused_condense_clutter') c.clutter++;
    else if (e.type === 'refused_condense_starving') c.starving++;
    else if (e.type === 'refused_catalyze_maxed') c.catalyzeMaxed++;
    else if (e.type === 'refused_fruit_forage') c.fruitForageRefuse++;
    else if (e.type === 'refused_satiated') c.satiated++;
    else if (e.type === 'refused_condense_prep') {
      c.prepRefuse++;
      const ro = String(e.payload?.refused_op || '');
      if (ro === 'move') c.prepRefuseMove++;
      else if (ro === 'pull' || ro === 'nudge') c.prepRefusePull++;
      else if (ro === 'bite') c.prepRefuseBite++;
      else c.prepRefuseOther++;
    }
  }
  for (const e of ev || []) {
    if (e.type !== 'micro_reward') continue;
    const r = String(e.payload?.reason || '');
    if (r.startsWith('pull')) c.pull++;
    else if (r.startsWith('adsorb')) c.adsorb++;
    else if (r.startsWith('catalyze')) c.catalyze++;
  }
  return c;
}

function snap() {
  const w = readWorld();
  const fruits = w.organics.filter((o) => o.kind === 'fruit');
  const fruit = fruits.reduce((s, o) => s + o.energy_locked, 0);
  const clumps = w.organics.filter((o) => o.kind === 'clump' && o.energy_locked > 0.01);
  const corpses = w.organics.filter((o) => o.kind === 'corpse');
  const aliveBots = w.bots.filter((b) => b.alive);
  const avgPool = aliveBots.length
    ? aliveBots.reduce((s, b) => s + b.energy_pool, 0) / aliveBots.length
    : 0;
  const c = countEvents(w.events);
  return {
    tick: w.tick,
    fruit: Math.round(fruit * 100) / 100,
    nFruit: fruits.length,
    alive: aliveBots.length,
    avgPool: Math.round(avgPool * 100) / 100,
    waste: Math.round(w.waste_heat * 100) / 100,
    cok: c.cok,
    clBite: c.clBite,
    fruitBite: c.fruitBite,
    death: c.death,
    wipeout: c.wipeout,
    revive: c.revive,
    revived: c.revived,
    hungryRevive: c.hungryRevive,
    pull: c.pull,
    adsorb: c.adsorb,
    catalyze: c.catalyze,
    micro_ok: c.pull + c.adsorb + c.catalyze,
    catalyzeMaxed: c.catalyzeMaxed,
    prepRefuse: c.prepRefuse,
    prepRefuseMove: c.prepRefuseMove,
    prepRefusePull: c.prepRefusePull,
    prepRefuseBite: c.prepRefuseBite,
    prepRefuseOther: c.prepRefuseOther,
    clutter: c.clutter,
    starving: c.starving,
    hungryBite: c.hungryBite,
    fruitForageRefuse: c.fruitForageRefuse,
    hungryMove: c.hungryMove,
    wait: c.wait,
    move: c.move,
    satiated: c.satiated,
    clumps: clumps.length,
    corpses: corpses.length,
  };
}

function writeReady(kind, payload) {
  fs.writeFileSync(READY, JSON.stringify({ kind, ...payload }, null, 2));
  console.log('READY', kind, payload);
}

for (const f of [READY, GONE]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
fs.writeFileSync(POLL, '');
const t0 = Date.now();
let goneTick = null;
let lastTick = -1;
let peakFruitBite = 0;
let flatAnchor = null; // { tick, fruit } when fruit first looks flat after forage activity
console.log('obs15 poll start', new Date().toISOString(), 'WORLD=', WORLD);

while (Date.now() - t0 < MAX_WALL_MS) {
  let s;
  try { s = snap(); } catch (e) {
    console.error('read fail', e.message);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, INTERVAL_MS);
    continue;
  }
  if (s.fruitBite > peakFruitBite) peakFruitBite = s.fruitBite;

  if (s.tick !== lastTick) {
    fs.appendFileSync(POLL, JSON.stringify(s) + '\n');
    console.log(JSON.stringify(s));
    lastTick = s.tick;
  }

  if (goneTick == null && (s.fruit < 0.5 || s.nFruit === 0)) {
    goneTick = s.tick;
    fs.writeFileSync(GONE, String(goneTick));
    console.log('FRUIT_GONE at tick', goneTick);
  }

  if (goneTick != null && s.tick - goneTick >= TARGET_N) {
    writeReady('fruit_gone', {
      ready: true,
      goneTick,
      tick: s.tick,
      N: s.tick - goneTick,
      fruit: s.fruit,
      alive: s.alive,
      micro_ok: s.micro_ok,
      pull: s.pull,
      adsorb: s.adsorb,
      catalyze: s.catalyze,
      catalyzeMaxed: s.catalyzeMaxed,
      prepRefuse: s.prepRefuse,
      fruitForageRefuse: s.fruitForageRefuse,
      hungryMove: s.hungryMove,
      clutter: s.clutter,
      cok: s.cok,
      clBite: s.clBite,
      death: s.death,
      revive: s.revive,
      fruitBite: s.fruitBite,
      at: new Date().toISOString(),
    });
    fs.appendFileSync(POLL, JSON.stringify({ ...s, done: true, kind: 'fruit_gone', goneTick, wall_ms: Date.now() - t0 }) + '\n');
    process.exit(0);
  }

  // STALL: after some forage window (peak fb≥1), fruit flat (±0.05) for ≥800 ticks and sliding fb dead
  if (goneTick == null && peakFruitBite >= 1 && s.fruit > 50) {
    if (!flatAnchor) {
      flatAnchor = { tick: s.tick, fruit: s.fruit };
    } else {
      const dFruit = Math.abs(s.fruit - flatAnchor.fruit);
      if (dFruit > 0.05) {
        // fruit still moving — reset anchor
        flatAnchor = { tick: s.tick, fruit: s.fruit };
      } else if (s.tick - flatAnchor.tick >= STALL_FLAT_TICKS) {
        // Confirm death/wait loop signal loosely (optional soft)
        writeReady('stall', {
          ready: true,
          stall: true,
          fruit_gone: false,
          N: null,
          flatFromTick: flatAnchor.tick,
          flatTicks: s.tick - flatAnchor.tick,
          flatFruit: flatAnchor.fruit,
          tick: s.tick,
          fruit: s.fruit,
          alive: s.alive,
          fruitBite: s.fruitBite,
          peakFruitBite,
          death: s.death,
          revive: s.revive,
          wait: s.wait,
          hungryMove: s.hungryMove,
          fruitForageRefuse: s.fruitForageRefuse,
          micro_ok: s.micro_ok,
          catalyzeMaxed: s.catalyzeMaxed,
          prepRefuse: s.prepRefuse,
          cok: s.cok,
          clBite: s.clBite,
          at: new Date().toISOString(),
        });
        fs.appendFileSync(POLL, JSON.stringify({ ...s, done: true, kind: 'stall', wall_ms: Date.now() - t0 }) + '\n');
        process.exit(0);
      }
    }
  }

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, INTERVAL_MS);
}
console.error('obs15 wall timeout');
process.exit(2);
