// commands.js  – command parsing, user state & smart handlers with multi-token portfolio
import fetch from 'node-fetch';
import redis from './redisClient.js';
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  conn,
  quoteSOLto,
  executeSwap,
  burnAndDev,
  watchDeposits,
  refreshBalances,
  NXR_MINT
} from './utils-solana.js';
import { upsertUser, getUser, getAllUsers } from './db.js';
import { remember, recall } from './memory.js';
import { enqueueTrade } from './jobQueue.js';

const users         = new Map();
const AGENT_MINT_PK = new PublicKey(process.env.AGENT_MINT);
const PERSONA       = process.env.AGENT_PERSONA.replace('%AGENT%', process.env.AGENT_NAME);
const GOALS         = process.env.AGENT_GOALS;
const OLLAMA_URL    = process.env.OLLAMA_URL;
const OLLAMA_MODEL  = process.env.OLLAMA_MODEL;
const USDC_MINT     = process.env.USDC_MINT; // e.g. EPjFW...

// ─── Command‐trigger regexes ──────────────────────────────────────────────
const BUY_RX    = /(?:\/buy|buy)\s+([A-Za-z0-9]{32,44})\s+([\d.]+)/i;
const SELL_RX   = /(?:\/sell|sell)\s+([A-Za-z0-9]{32,44})\s+([\d.]+)/i;
const DEP_RX    = /\b(deposit|wallet)\b/i;
const BAL_RX    = /\bbalance\b/i;
const PORT_RX   = /\b(?:holdings|portfolio|how much i hold)\b/i;
const PRICE_RX  = /\b(?:sol(?:ana)? price|price of solana)\b/i;
const AUTO_RX   = /\bauto(?:trade)?\s*(on|off)\b/i;
const RISK_RX   = /\brisk\s*(low|med|high)\b/i;
const TW_HANDLE = (process.env.AGENT_TW_HANDLE||'').toLowerCase();

// ─── Helpers to strip self‐mention ─────────────────────────────────────────
function stripMention(txt) {
  return TW_HANDLE ? txt.replace(new RegExp(`@${TW_HANDLE}`, 'ig'), '').trim() : txt;
}

// ─── Fetch USD price for SOL, cascading APIs ──────────────────────────────
async function fetchSolPrice() {
  // 1) Binance
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
    const j   = await res.json();
    if (j.price) return parseFloat(j.price);
  } catch (e) {
    console.warn('⚠️ Binance SOL price fetch failed', e);
  }
  // 2) CoinGecko
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const j   = await res.json();
    if (j.solana?.usd) return j.solana.usd;
  } catch (e) {
    console.warn('⚠️ CoinGecko SOL price fetch failed', e);
  }
  // 3) On‐chain via Jupiter→USDC
  try {
    const route = await quoteSOLto(USDC_MINT, LAMPORTS_PER_SOL);
    if (route?.outAmount) return route.outAmount / 1e6; // USDC is 6 decimals
  } catch (e) {
    console.warn('⚠️ Jupiter SOL→USDC quote failed', e);
  }
  return null;
}

// ─── Fetch USD prices for SPL tokens via CoinGecko ────────────────────────
async function fetchTokenPrices(mints) {
  if (!mints.length) return {};
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${mints.join(',')}&vs_currencies=usd`
    );
    return await res.json();
  } catch (e) {
    console.warn('⚠️ fetchTokenPrices failed', e);
    return {};
  }
}

// ─── Initialize users from Redis + on-chain watcher ──────────────────────
export async function initializeUsers() {
  const handles = await getAllUsers();
  for (const handle of handles) {
    const data = await getUser(handle);
    if (!data) continue;
    const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(data.wallet)));
    users.set(handle, {
      wallet,
      sol    : parseFloat(data.sol),
      tierBal: parseFloat(data.tierBal),
      auto   : data.auto === 'true',
      risk   : data.risk
    });
  }
  watchDeposits(users, AGENT_MINT_PK, async (handle, u) => {
    users.set(handle, u);
    await persist(handle, u);
    if (u.auto && u.sol > 0.05) {
      await enqueueTrade({ cmd: { t:'sell', mint:'So11111111111111111111111111111111111111112', sol:0.02 }, handle });
    }
  });
}

// ─── Persist helper ───────────────────────────────────────────────────────
async function persist(handle, u) {
  await upsertUser(handle, {
    wallet:  JSON.stringify(Array.from(u.wallet.secretKey)),
    sol:     u.sol.toString(),
    tierBal: u.tierBal.toString(),
    auto:    u.auto.toString(),
    risk:    u.risk
  });
}

// ─── Ensure & basic getters ───────────────────────────────────────────────
export async function ensure(handle) {
  let u = users.get(handle);
  if (u) return u;
  u = { wallet: Keypair.generate(), sol:0, tierBal:0, auto:false, risk:'med' };
  users.set(handle, u);
  await persist(handle, u);
  console.log('[NEW]', handle, '→', u.wallet.publicKey.toBase58());
  return u;
}
export async function walletOf(handle) {
  const u = await ensure(handle);
  return u.wallet.publicKey.toBase58();
}
export async function balanceOf(handle) {
  const u = await ensure(handle);
  return { sol: u.sol.toFixed(3), tier: u.tierBal };
}

// ─── Live on-chain refresh ────────────────────────────────────────────────
async function updateBalances(handle) {
  const u = users.get(handle) || await ensure(handle);
  const { sol, agentLamports } = await refreshBalances(u, AGENT_MINT_PK);
  u.sol     = sol;
  u.tierBal = agentLamports;
  await persist(handle, u);
  return { sol, tier: agentLamports };
}

// ─── Build multi-token portfolio snapshot ─────────────────────────────────
async function getPortfolio(handle) {
  const u = await ensure(handle);

  // SOL price & balance
  const solPrice = await fetchSolPrice();
  const { sol }  = await updateBalances(handle);
  const solUsd   = solPrice != null ? (sol * solPrice).toFixed(2) : 'N/A';

  // SPL balances
  const raw = await conn.getParsedTokenAccountsByOwner(u.wallet.publicKey, { programId: TOKEN_PROGRAM_ID });
  const balances = {};
  for (const { account } of raw.value) {
    const info = account.data.parsed.info;
    const amt  = parseFloat(info.tokenAmount.uiAmountString);
    if (amt > 0) balances[info.mint] = (balances[info.mint] || 0) + amt;
  }

  // token prices
  const prices = await fetchTokenPrices(Object.keys(balances));
  const tokens = [];
  let totalUsd = solPrice != null ? sol * solPrice : 0;
  for (const [mint, amt] of Object.entries(balances)) {
    const priceObj = prices[mint.toLowerCase()];
    const price    = priceObj?.usd ?? 0;
    const usdValue = (amt * price).toFixed(2);
    tokens.push({ mint, amount: amt, price, usdValue });
    totalUsd += parseFloat(usdValue);
  }

  // persist for analysis
  const snapshot = { ts: Date.now(), sol, solUsd, tokens };
  await redis.xadd(`portfolio_history:${handle}`, '*', 'data', JSON.stringify(snapshot));

  return { sol, solUsd, tokens, totalUsd: totalUsd.toFixed(2) };
}

// ─── Preference setters ───────────────────────────────────────────────────
const riskName = r => r === 'low' ? 'conservative' : r === 'high' ? 'aggressive' : 'balanced';
export function toggleAuto(handle, state) {
  const u = users.get(handle);
  u.auto = (typeof state === 'boolean') ? state : !u.auto;
  persist(handle, u);
  return { autoTrade: u.auto, risk: riskName(u.risk) };
}
export function setRisk(handle, level) {
  const u = users.get(handle);
  u.risk = level;
  persist(handle, u);
  return { autoTrade: u.auto, risk: riskName(u.risk) };
}

// ─── Trade dispatcher ─────────────────────────────────────────────────────
async function dispatchTrade(cmd, handle, reply) {
  await enqueueTrade({ cmd, handle });
  if (typeof reply === 'function') {
    reply(`🔄 Trade queued: ${cmd.t} ${cmd.sol} SOL`);
  }
}

// ─── AI / Fallback dispatcher ─────────────────────────────────────────────
async function dispatchAI(text, handle, reply) {
  const clean = stripMention(text);

  // 1) Immediate price & portfolio queries
  if (PRICE_RX.test(clean)) {
    const price = await fetchSolPrice();
    return price != null
      ? reply(`🚀 SOL is currently $${price.toFixed(2)} USD.`)
      : reply('❌ Could not fetch SOL price right now.');
  }
  if (PORT_RX.test(clean)) {
    const p = await getPortfolio(handle);
    let resp = `**Portfolio (Total $${p.totalUsd})**\n• SOL: ${p.sol.toFixed(3)} (~$${p.solUsd})\n`;
    for (const t of p.tokens) {
      resp += `• ${t.mint.slice(0,6)}…: ${t.amount} @ $${t.price} → $${t.usdValue}\n`;
    }
    return reply(resp);
  }

  // 2) Otherwise, full LLM conversation with injected real-time data
  try {
    // record user
    await remember({ handle, text, ts: Date.now() });
    // recall history
    const history = await recall(handle, 10);
    let context = '';
    for (const msg of history) context += `User: ${msg.text}\n`;
    // inject live facts
    const priceNow = await fetchSolPrice();
    const port     = await getPortfolio(handle);
    const portLines= [
      `SOL:  ${port.sol.toFixed(3)}  (~$${port.solUsd})`,
      ...port.tokens.map(t =>
        `${t.mint.slice(0,6)}… : ${t.amount} @ $${t.price} = $${t.usdValue}`
      )
    ].join('\n');
    context += `User: ${text}\n\n` +
               `### Real-time facts\n` +
               `SOL price: $${priceNow ?? 'N/A'}\n` +
               `Portfolio:\n${portLines}\n` +
               `AI:`;

    const body = { model: OLLAMA_MODEL, prompt: `${PERSONA}\nGoals: ${GOALS}\n\n${context}`, stream: false };
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const answer = (await res.json()).response.trim();
    reply(answer);
    await remember({ handle, text: answer, ts: Date.now() });
  } catch (err) {
    console.error('[AI error]', err);
    reply('🤖 …sorry, I had a brain-freeze.');
  }
}

// ─── Top‐level handler ────────────────────────────────────────────────────
export async function handleMessage(m) {
  // 1) button payload
  if (m.button) {
    const [, act, arg] = m.button.split('::');
    const h = m.handle;
    if (act === 'AUTO')
      return m.reply(`Auto-trading *${toggleAuto(h, arg==='on').autoTrade ? 'ENABLED ✅' : 'DISABLED ❌'}*`);
    if (act === 'RISK')
      return m.reply(`Risk profile → *${setRisk(h, arg).risk}*`);
    if (act==='QBUY'||act==='QSELL') {
      const side = act==='QBUY' ? 'buy' : 'sell';
      return dispatchTrade({ t:side, mint:arg, sol:0.10 }, h, m.reply);
    }
  }

  // 2) text commands
  const txt   = m.text ?? '';
  const clean = stripMention(txt);
  let cmd     = null;
  if (BUY_RX.test(clean))         { const [,m,s]=clean.match(BUY_RX);    cmd={ t:'buy',    mint:m, sol:+s }; }
  else if (SELL_RX.test(clean))   { const [,m,s]=clean.match(SELL_RX);   cmd={ t:'sell',   mint:m, sol:+s }; }
  else if (DEP_RX.test(clean))    cmd = { t:'deposit' };
  else if (BAL_RX.test(clean))    cmd = { t:'balance' };
  else if (PORT_RX.test(clean))   cmd = { t:'portfolio' };
  else if (PRICE_RX.test(clean))  cmd = { t:'price' };
  else {
    const a = clean.match(AUTO_RX); if (a) cmd = { t:'auto', val:a[1] };
    const b = clean.match(RISK_RX); if (b) cmd = { t:'risk', val:b[1] };
  }

  if (cmd) {
    switch (cmd.t) {
      case 'deposit':
        return m.reply(`🔑 Deposit address:\n${await walletOf(m.handle)}`);
      case 'balance': {
        const b = await updateBalances(m.handle);
        return m.reply(`Wallet SOL: ${b.sol.toFixed(3)}\nAgent tokens: ${b.tier}`);
      }
      case 'portfolio': {
        const p = await getPortfolio(m.handle);
        let resp = `**Portfolio (Total $${p.totalUsd})**\n• SOL: ${p.sol.toFixed(3)} (~$${p.solUsd})\n`;
        for (const t of p.tokens) {
          resp += `• ${t.mint.slice(0,6)}…: ${t.amount} @ $${t.price} → $${t.usdValue}\n`;
        }
        return m.reply(resp);
      }
      case 'price': {
        const price = await fetchSolPrice();
        return price != null
          ? m.reply(`🚀 SOL is currently $${price.toFixed(2)} USD.`)
          : m.reply('❌ Could not fetch SOL price right now.');
      }
      case 'auto':
        return m.reply(`Auto-trading *${toggleAuto(m.handle, cmd.val==='on').autoTrade ? 'ENABLED ✅' : 'DISABLED ❌'}*`);
      case 'risk':
        return m.reply(`Risk profile → *${setRisk(handle, cmd.val).risk}*`);
      case 'buy': case 'sell':
        return dispatchTrade(cmd, m.handle, m.reply);
      default:
        break;
    }
  }

  // 3) fallback → AI
  return dispatchAI(txt, m.handle, m.reply);
}

// ─── Explicit exports for index.js ────────────────────────────────────────
export {
  fetchSolPrice,
  getPortfolio,
  recall
};
