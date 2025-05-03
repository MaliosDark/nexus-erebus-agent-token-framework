// index.js  –  Nexus Agent (Telegram‑first, Twitter optional)
import 'dotenv/config'
import fetch                          from 'node-fetch'
import { Keypair, LAMPORTS_PER_SOL,
         PublicKey }                  from '@solana/web3.js'

import { TelegramClient }             from './telegram-client.js'
import { TwitterClient  }             from './twitter-client.js'
import { quoteSOLto, executeSwap,
         burnAndDev, watchDeposits,
         refreshBalances, NXR_MINT }  from './utils-solana.js'

import { db, upsertUser }             from './db.js'
import { withRetry }                  from './retry.js'
import { firewall }                   from './firewall.js'
import { remember }                   from './memory.js'

// ─── feature flags ────────────────────────────────────────────────────────────
const USE_TELEGRAM = process.env.USE_TELEGRAM !== 'false'
const USE_TWITTER  = process.env.USE_TWITTER  === 'true'

// ─── ENV ---------------------------------------------------------------------
const AGENT_NAME    = process.env.AGENT_NAME
const AGENT_MINT_PK = new PublicKey(process.env.AGENT_MINT)
const TW_HANDLE     = (process.env.AGENT_TW_HANDLE ?? '').toLowerCase() // <- NEW
const [TIER_MIN]    = process.env.TIER_THRESHOLDS.split(',').map(Number)
const MIN_NXR_SOL   = +process.env.MIN_NXR_SOL  || 0.02
const MIN_SOL_FEES  = +process.env.MIN_SOL_FEES || 0.005
const NXR_BURN_PCT  = +process.env.NXR_BURN_PCT || 0.40

const PERSONA       = process.env.AGENT_PERSONA.replace('%AGENT%', AGENT_NAME)
const GOALS         = process.env.AGENT_GOALS
const OLLAMA_URL    = process.env.OLLAMA_URL
const OLLAMA_MODEL  = process.env.OLLAMA_MODEL

// ─── users in‑memory  +  hydration from DB  ----------------------------------
const users = new Map()
db.data.users?.forEach(u => users.set(u.handle, {
  wallet : Keypair.fromSecretKey(Uint8Array.from(u.wallet)),
  sol    : u.sol,
  tierBal: u.tierBal,
  auto   : u.auto ?? false,
  risk   : u.risk ?? 'med'
}))

function persist(handle, u){
  upsertUser(handle, {
    wallet  : Array.from(u.wallet.secretKey),
    sol     : u.sol,
    tierBal : u.tierBal,
    auto    : u.auto,
    risk    : u.risk
  })
}

// ─── helpers -----------------------------------------------------------------
function ensure(handle){
  let u = users.get(handle)
  if (u) return u
  u = { wallet: Keypair.generate(), sol:0, tierBal:0, auto:false, risk:'med' }
  users.set(handle, u)
  persist(handle, u)
  console.log('[NEW]', handle, '→', u.wallet.publicKey.toBase58())
  return u
}
const walletOf  = h => ensure(h).wallet.publicKey.toBase58()
const balanceOf = h => { const u = ensure(h); return { sol:u.sol.toFixed(3), tier:u.tierBal } }

const riskName  = r => r==='low' ? 'conservative'
                    : r==='high'? 'aggressive'
                    : 'balanced'

function toggleAuto(handle, state /* bool | undefined */){
  const u = ensure(handle)
  u.auto = (typeof state === 'boolean') ? state : !u.auto
  persist(handle, u)
  return { autoTrade: u.auto, risk: riskName(u.risk) }
}
function setRisk(handle, level /* low|med|high */){
  const u = ensure(handle)
  u.risk = level
  persist(handle, u)
  return { autoTrade: u.auto, risk: riskName(u.risk) }
}

// ─── Ollama ------------------------------------------------------------------
async function ai(prompt){
  const body = { model: OLLAMA_MODEL,
                 prompt: `${PERSONA}\nGoals: ${GOALS}\n\nUser: ${prompt}\nAI:`,
                 stream:false }
  const r = await fetch(OLLAMA_URL,{method:'POST',body:JSON.stringify(body)})
  return (await r.json()).response.trim()
}

// ─── regex helpers (Telegram & Twitter) --------------------------------------
const BUY_RX   = /(?:\/buy|buy)\s+([A-Za-z0-9]{32,44})\s+([\d.]+)/i
const SELL_RX  = /(?:\/sell|sell)\s+([A-Za-z0-9]{32,44})\s+([\d.]+)/i
const DEP_RX   = /\b(deposit|wallet)\b/i
const BAL_RX   = /\bbalance\b/i
const AUTO_RX  = /\bauto(?:trade)?\s*(on|off)\b/i
const RISK_RX  = /\brisk\s*(low|med|high)\b/i

function stripMention(txt){
  return TW_HANDLE ? txt.replace(new RegExp(`@${TW_HANDLE}`,'ig'), '').trim() : txt
}

// ─── string → command object --------------------------------------------------
function parseTxt(msg){
  const clean = stripMention(msg)
  if (BUY_RX .test(clean)){ const [,m,s]=clean.match(BUY_RX ); return {t:'buy' ,mint:m,sol:+s} }
  if (SELL_RX.test(clean)){ const [,m,s]=clean.match(SELL_RX); return {t:'sell',mint:m,sol:+s} }
  if (DEP_RX .test(clean)) return {t:'deposit'}
  if (BAL_RX .test(clean)) return {t:'balance'}
  const a = clean.match(AUTO_RX); if(a) return {t:'auto',val:a[1]}
  const b = clean.match(RISK_RX); if(b) return {t:'risk',val:b[1]}
  return null
}

// ─── swap / trade (sin cambios) ---------------------------------------------
async function swap(cmd,u){
  const lam  = cmd.sol * LAMPORTS_PER_SOL
  const mint = cmd.mint
  const route = await quoteSOLto(
    cmd.t==='buy' ? mint : 'So11111111111111111111111111111111111111112', lam)
  await executeSwap(route, u.wallet)
  return route
}
async function trade(cmd, u, reply){
  if (u.sol < cmd.sol + MIN_SOL_FEES)
    return reply('❌ Not enough SOL')
  if (u.tierBal < TIER_MIN)
    return reply(`❌ Need ${TIER_MIN} ${AGENT_NAME} tokens`)

  const fuel = await quoteSOLto(NXR_MINT.toBase58(), MIN_NXR_SOL*LAMPORTS_PER_SOL)
  await executeSwap(fuel,u.wallet)
  await burnAndDev(u.wallet, fuel.outAmount, NXR_BURN_PCT)

  await swap(cmd,u)
  reply(await ai(`${cmd.t==='buy'?'Bought':'Sold'} ${cmd.sol} SOL worth`))
}

// ─── unified dispatcher (Telegram + Twitter) ---------------------------------
async function handleMessage(m){
  remember({handle:m.handle, text:m.text ?? '', ts:Date.now()})

  // 1) payload de botón  ────────────────────────────────────────
  if (m.button){
    const [, act, arg ] = m.button.split('::')      // BTN::<act>::<arg>::user
    const h  = m.handle
    if (act==='AUTO'){
      const st = toggleAuto(h, arg==='on')
      return m.reply(`Auto‑trading *${st.autoTrade?'ENABLED ✅':'DISABLED ❌'}*`,
                     {parse_mode:'Markdown'})
    }
    if (act==='RISK'){
      const st = setRisk(h, arg)
      return m.reply(`Risk profile → *${st.risk}*`, {parse_mode:'Markdown'})
    }
    if (act==='QBUY' || act==='QSELL'){
      const side = act==='QBUY' ? 'buy' : 'sell'
      const quick = { t:side, mint: arg, sol:0.10 }
      const u = ensure(h)
      return withRetry(()=>trade(quick,u,m.reply))
              .catch(e=>{ firewall.onError('trade'); console.error(e); m.reply('❌ trade failed') })
    }
    return
  }

  // 2) texto reconocido como comando (/buy, /sell, deposit…)
  const cmd = m.text && parseTxt(m.text)
  if (cmd){
    // acciones no financieras
    if (cmd.t==='deposit')  return m.reply(`🔑 Deposit address (SOL):\n${walletOf(m.handle)}`)
    if (cmd.t==='balance'){ const b=balanceOf(m.handle); return m.reply(`Wallet SOL: ${b.sol}\nAgent tokens: ${b.tier}`) }
    if (cmd.t==='auto'){ const st=toggleAuto(m.handle,cmd.val==='on'); return m.reply(`Auto‑trading *${st.autoTrade?'ENABLED ✅':'DISABLED ❌'}*`,{parse_mode:'Markdown'}) }
    if (cmd.t==='risk'){ const st=setRisk(m.handle,cmd.val); return m.reply(`Risk profile → *${st.risk}*`,{parse_mode:'Markdown'}) }

    // trading
    const u = ensure(m.handle)
    return withRetry(()=>trade(cmd,u,m.reply))
            .catch(e=>{ firewall.onError('trade ex'); console.error(e); m.reply('❌ trade failed') })
  }

  // 3)  — Si nada coincide → respuesta de IA 🧠 -------------------------------
  if (m.text){
    try {
      const answer = await ai(m.text)
      return m.reply(answer)
    } catch (err){
      console.error('[AI]', err)
      return m.reply('🤖 …sorry, I had a brain‑freeze.')
    }
  }
}

// ─── Solana watchers (igual) --------------------------------------------------
watchDeposits(users,AGENT_MINT_PK,async(h,u)=>{
  try{
    const {sol,agentLamports}=await refreshBalances(u,AGENT_MINT_PK)
    Object.assign(u,{sol,tierBal:agentLamports}); persist(h,u)
    if(u.auto && sol>0.05){
      await trade({t:'sell',mint:'So11111111111111111111111111111111111111112',sol:0.02},u,()=>{})
    }
  }catch(e){ firewall.onError('refresh balance') }
})
setInterval(()=>console.log('🛡️ ', firewall.statusBar()),60_000)

// ─── BOOT --------------------------------------------------------------------
const tg = USE_TELEGRAM ? new TelegramClient() : null
const tw = USE_TWITTER  ? new TwitterClient()  : null

if (USE_TELEGRAM){
  tg.setHelpers({
    walletOf, balanceOf, ensureUser:ensure,
    toggleAuto:(h,st)=>toggleAuto(h,st)
  })
  await tg.init(handleMessage)
  console.log('[BOOT] Telegram ON')
}
if (USE_TWITTER){
  await tw.init()
  tw.setHelpers({ walletOf, balanceOf })
  tw.onMessage?.(twMsg=>{
    handleMessage({
      platform : 'twitter',
      handle   : twMsg.handle.toLowerCase(),
      text     : twMsg.text,
      reply    : txt => twMsg.reply(txt)
    })
  })
  console.log('[BOOT] Twitter  ON')
}

console.log(`[${AGENT_NAME}] ready → ${[
  USE_TELEGRAM && 'Telegram',
  USE_TWITTER  && 'Twitter'
].filter(Boolean).join(' + ')}`)
