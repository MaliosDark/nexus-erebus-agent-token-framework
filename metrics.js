// metrics.js — BullMQ workers + Prometheus metrics
import 'dotenv/config';
import http from 'http';
import { createClient } from 'redis';
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
import { Telegram } from 'telegraf';
import { Counter, Histogram, Gauge, collectDefaultMetrics, Registry } from 'prom-client';

const connection = { connection: createClient({ url: process.env.REDIS_URL }) };
await connection.connection.connect();  // BullMQ client

const tg = process.env.USE_TELEGRAM !== 'false'
  ? new Telegram(process.env.TELEGRAM_BOT_TOKEN)
  : null;

// ——— Prometheus setup —————————————————————————
const register = new Registry();
// collect standard Node.js metrics
collectDefaultMetrics({ register });

// Trade job metrics
const tradeJobsTotal = new Counter({
  name: 'trade_jobs_total',
  help: 'Total number of trade jobs processed',
  labelNames: ['status'],
  registers: [register],
});
const tradeJobDuration = new Histogram({
  name: 'trade_job_duration_seconds',
  help: 'Duration of trade job execution in seconds',
  buckets: [0.1, 0.5, 1, 2, 5],
  registers: [register],
});

// LLM job metrics
const llmJobsTotal = new Counter({
  name: 'llm_jobs_total',
  help: 'Total number of LLM jobs processed',
  labelNames: ['status'],
  registers: [register],
});
const llmJobDuration = new Histogram({
  name: 'llm_job_duration_seconds',
  help: 'Duration of LLM job execution in seconds',
  buckets: [0.01, 0.05, 0.1, 0.5, 1],
  registers: [register],
});

// Firewall HP gauge
const firewallHp = new Gauge({
  name: 'firewall_hp',
  help: 'Current firewall HP',
  registers: [register],
});

// Start HTTP server for metrics
const METRICS_PORT = process.env.METRICS_PORT || 9201;
http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': register.contentType });
    res.end(await register.metrics());
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(METRICS_PORT, () => {
  console.log(`📊 Metrics server listening on :${METRICS_PORT}/metrics`);
});

// ——— Pub/Sub subscriber for firewall events —————————————————
// Duplicate the main connection so it’s not in pub/sub mode itself
const subscriber = connection.connection.duplicate();
await subscriber.connect();
await subscriber.subscribe('nexus.events', (msg) => {
  try {
    const e = JSON.parse(msg);
    if (e.event === 'firewall') {
      firewallHp.set(e.hp);
    }
    // if you publish captcha failures, bump them here:
    // if (e.event === 'captcha_failure') captchaFailuresTotal.inc();
  } catch {}
});

// Helper to wrap job logic in metrics
async function withMetrics(counter, histogram, jobFn) {
  const end = histogram.startTimer();
  try {
    await jobFn();
    counter.labels('success').inc();
  } catch (err) {
    counter.labels('failure').inc();
    throw err;
  } finally {
    end();
  }
}

// ——— Trade worker —————————————————————————
new Worker('trades', async job => {
  await withMetrics(tradeJobsTotal, tradeJobDuration, async () => {
    const { cmd, handle } = job.data;
    const data = await getUser(handle);
    if (!data) throw new Error(`User ${handle} not found`);
    const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(data.wallet)));
    const lamports = cmd.sol * LAMPORTS_PER_SOL;
    const mint = cmd.t === 'buy'
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
      sol: sol.toString(),
      tierBal: agentLamports.toString()
    });

    // 4) notify
    if (tg) await tg.sendMessage(`@${handle}`, `✅ [Trade] ${cmd.t} ${cmd.sol} SOL`);
  });
}, connection);

// ——— LLM worker ———————————————————————————
new Worker('llm', async job => {
  await withMetrics(llmJobsTotal, llmJobDuration, async () => {
    const { text, handle } = job.data;
    const prompt = `${process.env.AGENT_PERSONA.replace('%AGENT%', process.env.AGENT_NAME)}
Goals: ${process.env.AGENT_GOALS}

User: ${text}
AI:`;
    const res = await fetch(process.env.OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ model: process.env.OLLAMA_MODEL, prompt, stream: false })
    });
    const reply = (await res.json()).response.trim();
    if (tg) await tg.sendMessage(`@${handle}`, reply);
  });
}, connection);
