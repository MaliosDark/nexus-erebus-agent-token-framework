// index.js  –  Nexus Agent (Telegram-first, Twitter optional)
//              spawns & monitors Metrics and Worker services via child_process

import 'dotenv/config';
import { spawn } from 'child_process';
import fetch                       from 'node-fetch';
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

import { TelegramClient }          from './telegram-client.js';
import { TwitterClient }           from './twitter-client.js';
import {
  quoteSOLto,
  executeSwap,
  burnAndDev,
  watchDeposits,
  refreshBalances,
  NXR_MINT
} from './utils-solana.js';

import { upsertUser, getUser, getAllUsers } from './db.js';
import { withRetry }             from './retry.js';
import { firewall }              from './firewall.js';
import { remember }              from './memory.js';
import { enqueueTrade, enqueueLLM } from './jobQueue.js';

// ─── Spawn & monitor child services -----------------------------------------
function startService(name, script) {
  let proc;
  const start = () => {
    console.log(`[${name}] starting ${script}`);
    proc = spawn(process.execPath, [script], { stdio: 'inherit' });
    proc.on('exit', (code, signal) => {
      console.error(`[${name}] exited with ${code ?? signal}. Restarting in 5s…`);
      setTimeout(start, 5000);
    });
  };
  start();
}

// Launch metrics.js and worker.js as separate monitored services
startService('Metrics', 'metrics.js');
startService('Worker', 'worker.js');


// ─── feature flags ────────────────────────────────────────────────────────────
const USE_TELEGRAM = process.env.USE_TELEGRAM !== 'false';
const USE_TWITTER  = process.env.USE_TWITTER  === 'true';

// ─── ENV ---------------------------------------------------------------------
const AGENT_NAME    = process.env.AGENT_NAME;
const AGENT_MINT_PK = new PublicKey(process.env.AGENT_MINT);
const TW_HANDLE     = (process.env.AGENT_TW_HANDLE ?? '').toLowerCase();
const [TIER_MIN]    = process.env.TIER_THRESHOLDS.split(',').map(Number);
const MIN_NXR_SOL   = +process.env.MIN_NXR_SOL  || 0.02;
const MIN_SOL_FEES  = +process.env.MIN_SOL_FEES || 0.005;
const NXR_BURN_PCT  = +process.env.NXR_BURN_PCT || 0.40;

const PERSONA       = process.env.AGENT_PERSONA.replace('%AGENT%', AGENT_NAME);
const GOALS         = process.env.AGENT_GOALS;
const OLLAMA_URL    = process.env.OLLAMA_URL;
const OLLAMA_MODEL  = process.env.OLLAMA_MODEL;

// ─── users in-memory + hydration from Redis  --------------------------------
const users = new Map();
const handles = await getAllUsers();
for (const handle of handles) {
  const data = await getUser(handle);
  if (!data) continue;
  const walletArray = JSON.parse(data.wallet);
  users.set(handle, {
    wallet : Keypair.fromSecretKey(Uint8Array.from(walletArray)),
    sol    : parseFloat(data.sol),
    tierBal: parseFloat(data.tierBal),
    auto   : data.auto === 'true',
    risk   : data.risk
  });
}

// ─── persist helper ---------------------------------------------------------
async function persist(handle, u) {
  await upsertUser(handle, {
    wallet  : JSON.stringify(Array.from(u.wallet.secretKey)),
    sol     : u.sol.toString(),
    tierBal : u.tierBal.toString(),
    auto    : u.auto.toString(),
    risk    : u.risk
  });
}

// ─── ensure user exists -----------------------------------------------------
async function ensure(handle) {
  let u = users.get(handle);
  if (u) return u;

  u = {
    wallet : Keypair.generate(),
    sol    : 0,
    tierBal: 0,
    auto   : false,
    risk   : 'med'
  };
  users.set(handle, u);
  await persist(handle, u);
  console.log('[NEW]', handle, '→', u.wallet.publicKey.toBase58());
  return u;
}

const walletOf = async h => (await ensure(h)).wallet.publicKey.toBase58();
const balanceOf = async h => {
  const u = await ensure(h);
  return { sol: u.sol.toFixed(3), tier: u.tierBal };
};

// ─── helpers -----------------------------------------------------------------
const riskName = r => r === 'low'
  ? 'conservative'
  : r === 'high'
    ? 'aggressive'
    : 'balanced';

function toggleAuto(handle, state /* bool | undefined */) {
  const u = users.get(handle);
  u.auto = (typeof state === 'boolean') ? state : !u.auto;
  persist(handle, u);
  return { autoTrade: u.auto, risk: riskName(u.risk) };
}

function setRisk(handle, level /* low|med|high */) {
  const u = users.get(handle);
  u.risk = level;
  persist(handle, u);
  return { autoTrade: u.auto, risk: riskName(u.risk) };
}

// ─── Ollama ------------------------------------------------------------------
async function ai(prompt) {
  const body = {
    model : OLLAMA_MODEL,
    prompt: `${PERSONA}\nGoals: ${GOALS}\n\nUser: ${prompt}\nAI:`,
    stream: false
  };
  const r = await fetch(OLLAMA_URL, { method: 'POST', body: JSON.stringify(body) });
  return (await r.json()).response.trim();
}

// ─── regex helpers (Telegram & Twitter) --------------------------------------
const BUY_RX   = /(?:\/buy|buy)\s+([A-Za-z0-9]{32,44})\s+([\d.]+)/i;
const SELL_RX  = /(?:\/sell|sell)\s+([A-Za-z0-9]{32,44})\s+([\d.]+)/i;
const DEP_RX   = /\b(deposit|wallet)\b/i;
const BAL_RX   = /\bbalance\b/i;
const AUTO_RX  = /\bauto(?:trade)?\s*(on|off)\b/i;
const RISK_RX  = /\brisk\s*(low|med|high)\b/i;

function stripMention(txt) {
  return TW_HANDLE
    ? txt.replace(new RegExp(`@${TW_HANDLE}`, 'ig'), '').trim()
    : txt;
}

// ─── string → command object ------------------------------------------------
function parseTxt(msg) {
  const clean = stripMention(msg);
  if (BUY_RX .test(clean)) { const [,m,s] = clean.match(BUY_RX ); return { t:'buy' , mint:m, sol:+s }; }
  if (SELL_RX.test(clean)) { const [,m,s] = clean.match(SELL_RX); return { t:'sell', mint:m, sol:+s }; }
  if (DEP_RX .test(clean)) return { t:'deposit' };
  if (BAL_RX .test(clean)) return { t:'balance' };
  const a = clean.match(AUTO_RX); if (a) return { t:'auto', val:a[1] };
  const b = clean.match(RISK_RX); if (b) return { t:'risk', val:b[1] };
  return null;
}

// ─── dispatch via queues ----------------------------------------------------
async function dispatchTrade(cmd, handle, reply) {
  await enqueueTrade({ cmd, handle });
  // si nos pasaron un reply válido, lo usamos para confirmar inmediatamente
  if (typeof reply === 'function') {
    reply(`🔄 Trade queued: ${cmd.t} ${cmd.sol} SOL`);
  }
  // en caso de botones no tenemos reply, el Worker notificará cuando esté listo
}

async function dispatchAI(text, handle, reply) {
  await enqueueLLM({ text, handle });
  reply('🤖 Your AI request is being processed…');
}

// ─── unified dispatcher (Telegram + Twitter) --------------------------------
async function handleMessage(m) {
  await remember({ handle: m.handle, text: m.text ?? '', ts: Date.now() });

  // 1) payload de botón
  if (m.button) {
    const [, act, arg] = m.button.split('::');
    const h = m.handle;
    if (act === 'AUTO') {
      const st = toggleAuto(h, arg === 'on');
      return m.reply(`Auto-trading *${st.autoTrade ? 'ENABLED ✅' : 'DISABLED ❌'}*`, { parse_mode: 'Markdown' });
    }
    if (act === 'RISK') {
      const st = setRisk(h, arg);
      return m.reply(`Risk profile → *${st.risk}*`, { parse_mode: 'Markdown' });
    }
    if (act === 'QBUY' || act === 'QSELL') {
      const side = act === 'QBUY' ? 'buy' : 'sell';
      const quick = { t:side, mint:arg, sol:0.10 };
      return dispatchTrade(quick, h, m.reply);
    }
  }

  // 2) texto reconocido como comando (/buy, /sell, deposit…)
  const cmd = m.text && parseTxt(m.text);
  if (cmd) {
    if (cmd.t === 'deposit') {
      const address = await walletOf(m.handle);
      return m.reply(`🔑 Deposit address:\n${address}`);
    }
    if (cmd.t === 'balance') {
      const b = await balanceOf(m.handle);
      return m.reply(`Wallet SOL: ${b.sol}\nAgent tokens: ${b.tier}`);
    }
    if (cmd.t === 'auto') {
      const st = toggleAuto(m.handle, cmd.val === 'on');
      return m.reply(`Auto-trading *${st.autoTrade ? 'ENABLED ✅' : 'DISABLED ❌'}*`, { parse_mode: 'Markdown' });
    }
    if (cmd.t === 'risk') {
      const st = setRisk(m.handle, cmd.val);
      return m.reply(`Risk profile → *${st.risk}*`, { parse_mode: 'Markdown' });
    }
    return dispatchTrade(cmd, m.handle, m.reply);
  }

  // 3) fallback → AI response
  if (m.text) {
    try {
      return dispatchAI(m.text, m.handle, m.reply);
    } catch (err) {
      console.error('[AI]', err);
      return m.reply('🤖 …sorry, I had a brain-freeze.');
    }
  }
}

// ─── Solana watchers --------------------------------------------------------
watchDeposits(users, AGENT_MINT_PK, async (h, u) => {
  try {
    const { sol, agentLamports } = await refreshBalances(u, AGENT_MINT_PK);
    Object.assign(u, { sol, tierBal: agentLamports });
    await persist(h, u);
    if (u.auto && sol > 0.05) {
      await enqueueTrade({
        cmd  : { t:'sell', mint:'So11111111111111111111111111111111111111112', sol:0.02 },
        handle: h
      });
    }
  } catch (e) {
    firewall.onError('refresh balance');
  }
});
setInterval(() => console.log('🛡️ ', firewall.statusBar()), 60_000);

// ─── BOOT --------------------------------------------------------------------
const tg = USE_TELEGRAM ? new TelegramClient() : null;
const tw = USE_TWITTER  ? new TwitterClient()  : null;

if (USE_TELEGRAM) {
  tg.setHelpers({
    walletOf,
    balanceOf,
    ensureUser: ensure,
    toggleAuto: (h, st) => toggleAuto(h, st)
  });
  await tg.init(handleMessage);
  console.log('[BOOT] Telegram ON');
}
if (USE_TWITTER) {
  await tw.init();
  tw.setHelpers({ walletOf, balanceOf });
  tw.onMessage?.(twMsg => {
    handleMessage({
      platform: 'twitter',
      handle  : twMsg.handle.toLowerCase(),
      text    : twMsg.text,
      reply   : txt => twMsg.reply(txt)
    });
  });
  console.log('[BOOT] Twitter ON');
}

console.log(`[${AGENT_NAME}] ready → ${
  [USE_TELEGRAM && 'Telegram', USE_TWITTER && 'Twitter'].filter(Boolean).join(' + ')
}`);
