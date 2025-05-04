// firewall.js — “Bubble Firewall” runtime shield (v2)
import 'dotenv/config';
import redis from './redisClient.js';

const MAX_HP        = +process.env.FW_MAX_HP        || 20;
const WEIGHTS       = {
  error   : +process.env.FW_WEIGHT_ERROR    || 2,
  rpcFail : +process.env.FW_WEIGHT_RPCFAIL  || 5,
  spam    : +process.env.FW_WEIGHT_SPAM     || 1,
  critical: +process.env.FW_WEIGHT_CRITICAL || 10
};
const HEAL_RATE     = +process.env.FW_HEAL_RATE     || 1;
const HEAL_INTERVAL = (+process.env.FW_HEAL_INTERVAL || 300) * 1000;
const BAR_LEN       = +process.env.FW_BAR_LENGTH    || 20;
const AUTO_EXIT     = process.env.FW_AUTO_EXIT !== 'false';

let hp = MAX_HP;
let lastIncident = Date.now();

function bar() {
  const filled = '█'.repeat(Math.round((hp / MAX_HP) * BAR_LEN));
  const empty  = ' '.repeat(BAR_LEN - filled.length);
  return `[${filled}${empty}] ${hp}/${MAX_HP}`;
}

async function record(type, msg = '') {
  const decay = WEIGHTS[type] || 1;
  hp = Math.max(0, hp - decay);
  lastIncident = Date.now();

  console.log(`⚠️  ${type.toUpperCase()}  -${decay}HP  ${bar()}`, msg);
  await redis.publish('nexus.events', JSON.stringify({ event: 'firewall', type, hp }));

  if (hp === 0 && AUTO_EXIT) {
    console.error('💥 Firewall bubble popped — shutting down.');
    process.exit(1);
  }
}

// auto-heal interval
setInterval(async () => {
  if (Date.now() - lastIncident > HEAL_INTERVAL && hp < MAX_HP) {
    hp = Math.min(MAX_HP, hp + HEAL_RATE);
    console.log(`🟢 Firewall heals +${HEAL_RATE}HP  ${bar()}`);
    await redis.publish('nexus.events', JSON.stringify({ event: 'firewall', type: 'heal', hp }));
  }
}, 30_000);

export const firewall = {
  onError   : (msg = '') => record('error', msg),
  onRpcFail : (msg = '') => record('rpcFail', msg),
  onSpam    : (msg = '') => record('spam', msg),
  onCritical: (msg = '') => record('critical', msg),

  statusBar : () => bar(),
  state     : () => ({ hp, max: MAX_HP, bar: bar().slice(1, -1) }),
  isAlive   : () => hp > 0
};
