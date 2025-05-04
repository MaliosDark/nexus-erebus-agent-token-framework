// worker.js – BullMQ workers for trades + LLM (solo HTTP, sin polling ni Telegraf)
import 'dotenv/config';
import redis from './redisClient.js';
import { Worker } from 'bullmq';
import { getUser, upsertUser } from './db.js';
import {
  quoteSOLto,
  executeSwap,
  burnAndDev,
  refreshBalances,
  NXR_MINT
} from './utils-solana.js';
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';

const connection   = { connection: redis };
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// Helper: notifica a un chat de Telegram vía HTTP
async function notifyTelegram(chatId, text) {
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id   : chatId,
        text,
        parse_mode: 'Markdown'
      })
    });
  } catch (err) {
    console.error('⚠️ Telegram notify failed:', err.message);
  }
}

// — Trades Worker ——————————————————————————————
new Worker('trades', async job => {
  const { cmd, handle } = job.data;

  // 1) Cargar usuario y clave
  const data = await getUser(handle);
  if (!data) throw new Error(`User ${handle} not found`);
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(data.wallet))
  );

  // 2) Quemar NXR de combustible
  const fuelRoute = await quoteSOLto(
    NXR_MINT.toBase58(),
    +process.env.MIN_NXR_SOL * LAMPORTS_PER_SOL
  );
  await executeSwap(fuelRoute, wallet);
  await burnAndDev(wallet, fuelRoute.outAmount, +process.env.NXR_BURN_PCT);

  // 3) Ejecutar el trade real
  const lamports = cmd.sol * LAMPORTS_PER_SOL;
  const mintAddr = cmd.t === 'buy'
    ? cmd.mint
    : 'So11111111111111111111111111111111111111112';
  const route = await quoteSOLto(mintAddr, lamports);
  await executeSwap(route, wallet);

  // 4) Refrescar y persistir balances
  const { sol, agentLamports } = await refreshBalances(
    { wallet },
    new PublicKey(process.env.AGENT_MINT)
  );
  await upsertUser(handle, {
    sol     : sol.toString(),
    tierBal : agentLamports.toString()
  });

  // 5) Notificar al usuario
  await notifyTelegram(handle, `✅ *Trade executed:* \`${cmd.t} ${cmd.sol} SOL\``);
}, connection);


// — LLM Worker ——————————————————————————————————
new Worker('llm', async job => {
  const { text, handle } = job.data;

  // 1) Construir prompt
  const prompt = `${process.env.AGENT_PERSONA.replace('%AGENT%', process.env.AGENT_NAME)}
Goals: ${process.env.AGENT_GOALS}

User: ${text}
AI:`;

  // 2) Llamar a Ollama
  const res = await fetch(process.env.OLLAMA_URL, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ model: process.env.OLLAMA_MODEL, prompt, stream: false })
  });
  const reply = (await res.json()).response.trim();

  // 3) Notificar la respuesta
  await notifyTelegram(handle, reply);
}, connection);
