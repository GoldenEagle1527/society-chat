const fs = require('fs');
const path = require('path');
const ROOT = process.env.OBS_ROOT || __dirname;
const POLL = path.join(ROOT, '_obs15_poll.jsonl');
const GONE = path.join(ROOT, '_obs15_gone_tick.txt');
const READY = path.join(ROOT, '_obs15_dump_ready.txt');
function lastPoll() {
  try {
    const lines = fs.readFileSync(POLL, 'utf8').trim().split(/\n/).filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  } catch { return null; }
}
const s = lastPoll();
const out = {
  ready: fs.existsSync(READY),
  readyBody: fs.existsSync(READY) ? fs.readFileSync(READY, 'utf8').trim() : null,
  goneFile: fs.existsSync(GONE),
  goneTick: fs.existsSync(GONE) ? fs.readFileSync(GONE, 'utf8').trim() : null,
  tick: s && s.tick,
  fruit: s && s.fruit,
  alive: s && s.alive,
  fruitBite: s && s.fruitBite,
  hungryMove: s && s.hungryMove,
  fruitForageRefuse: s && s.fruitForageRefuse,
  micro_ok: s && s.micro_ok,
  death: s && s.death,
  revive: s && s.revive,
  wait: s && s.wait,
  avgPool: s && s.avgPool,
  done: s && s.done,
  kind: s && s.kind,
};
if (out.goneTick != null && out.tick != null) out.N = Number(out.tick) - Number(out.goneTick);
console.log(JSON.stringify(out));
