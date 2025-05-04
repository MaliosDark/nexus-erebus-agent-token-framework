// worker.js – BullMQ workers for trades + LLM tasks (no extra polling)
import 'dotenv/config';
import redis from './redisClient.js';
import { Worker } from 'bullmq';
import { getUser, upsertUser } from './db.js';
import {
  quoteSOLto,
  executeSwap,
  burnAndDev,
  refreshBalances
} from './utils-solana.js';
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';
import { Telegram } from 'telegraf';

const connection = { connection: redis };
const tg = process.env.USE_TELEGRAM !== 'false'
  ? new Telegram(process.env.TELEGRAM_BOT_TOKEN)
  : null;

// ——— Trade worker —————————————————————————
new Worker('trades', async job => {
  const { cmd, handle } = job.data;

  // load user & wallet
  const data = await getUser(handle);
  if (!data) throw new Error(`User ${handle} not found`);
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(data.wallet)));

  // perform burns & swaps
  const lamports = cmd.sol * LAMPORTS_PER_SOL;
  const mint    = cmd.t === 'buy'
    ? cmd.mint
    : 'So11111111111111111111111111111111111111112';

  // 1) fuel burn
  const fuelRoute = await quoteSOLto(
    NXR_MINT.toBase58(),
    +process.env.MIN_NXR_SOL * LAMPORTS_PER_SOL
  );
  await executeSwap(fuelRoute, wallet);
  await burnAndDev(wallet, fuelRoute.outAmount, +process.env.NXR_BURN_PCT);

  // 2) actual trade
  const route = await quoteSOLto(mint, lamports);
  await executeSwap(route, wallet);

  // 3) refresh & persist balances
  const { sol, agentLamports } = await refreshBalances({ wallet }, new PublicKey(process.env.AGENT_MINT));
  await upsertUser(handle, {
    sol     : sol.toString(),
    tierBal : agentLamports.toString()
  });

  // 4) notify
  const msg = `✅ [Trade] ${cmd.t} ${cmd.sol} SOL`;
  if (tg) await tg.sendMessage(`@${handle}`, msg);

}, connection);


// ——— LLM worker ———————————————————————————
new Worker('llm', async job => {
  const { text, handle } = job.data;

  // build prompt
  const prompt = `${process.env.AGENT_PERSONA.replace('%AGENT%', process.env.AGENT_NAME)}
Goals: ${process.env.AGENT_GOALS}

User: ${text}
AI:`;
  const res = await fetch(process.env.OLLAMA_URL, {
    method : 'POST',
    body   : JSON.stringify({ model: process.env.OLLAMA_MODEL, prompt, stream: false })
  });
  const reply = (await res.json()).response.trim();

  // DM back
  if (tg) await tg.sendMessage(`@${handle}`, reply);

}, connection);
