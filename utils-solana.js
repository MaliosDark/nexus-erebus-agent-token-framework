// utils-solana.js  — Solana helpers (quote, swap, burn, live balance) with Redis caching & Pub/Sub
// ------------------------------------------------------------------
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmRawTransaction
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync
} from '@solana/spl-token';
import fetch from 'node-fetch';
import 'dotenv/config';

import redis        from './redisClient.js';
import { firewall } from './firewall.js';
import { withRetry } from './retry.js';

export const conn       = new Connection(process.env.RPC, 'confirmed');
export const NXR_MINT   = new PublicKey(process.env.NXR_MINT);
export const DEV_WALLET = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(process.env.DEV_WALLET_SK))
);
export const BURN_WALLET = new PublicKey('11111111111111111111111111111111');

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_Q = 'https://quote-api.jup.ag/v6/quote';
const JUP_S = 'https://quote-api.jup.ag/v6/swap';

const CACHE_TTL = 60;        // seconds
const decimalsCache = {};

// ---------- decimals cache ----------------------------------------
async function decimalsOf(mintPk) {
  const key = mintPk.toBase58();
  if (decimalsCache[key]) return decimalsCache[key];
  const info = await conn.getParsedAccountInfo(mintPk);
  const d = info.value.data.parsed.info.decimals;
  decimalsCache[key] = d;
  return d;
}

// ---------- Jupiter quote helper w/ Redis cache -------------------
export async function quoteSOLto(mint, lamports) {
  const cacheKey = `quote:${mint}:${lamports}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const url = `${JUP_Q}?inputMint=${SOL_MINT}` +
              `&outputMint=${mint}&amount=${lamports}&slippageBps=100`;
  const j = await fetch(url)
    .then(r => r.json())
    .catch(() => null);

  const result = j?.data?.[0] || null;
  if (result) {
    await redis.setEx(cacheKey, CACHE_TTL, JSON.stringify(result));
  }
  return result;
}

// ---------- execute swap w/ retry & Pub/Sub on failure -------------
export async function executeSwap(route, kp) {
  if (!route) {
    console.log('[SWAP] no route');
    return;
  }

  await withRetry(async () => {
    const r = await fetch(JUP_S, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        route,
        userPublicKey    : kp.publicKey.toBase58(),
        wrapAndUnwrapSol : true
      })
    }).then(r => r.json());

    const tx = Transaction.from(Buffer.from(r.swapTransaction, 'base64'));
    tx.partialSign(kp);
    const sig = await sendAndConfirmRawTransaction(
      conn,
      tx.serialize(),
      { skipPreflight: true }
    );
    console.log('[SWAP OK]', sig);

  }, { attempts: 3 })
  .catch(async (e) => {
    firewall.onRpcFail('swap failure');
    await redis.publish(
      'nexus.events',
      JSON.stringify({
        event: 'swap_failure',
        wallet: kp.publicKey.toBase58(),
        error: e.message
      })
    );
    throw e;
  });
}

// ---------- SPL transfer (burn/dev) w/ Pub/Sub on failure -----------
async function transfer(mintPk, fromKp, destPk, lamports) {
  const srcAta = getAssociatedTokenAddressSync(
    mintPk,
    fromKp.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  const ix = createTransferCheckedInstruction(
    srcAta,
    mintPk,
    destPk,
    fromKp.publicKey,
    lamports,
    await decimalsOf(mintPk)
  );
  const tx = new Transaction().add(ix);
  tx.feePayer = fromKp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(fromKp);

  await withRetry(
    () => sendAndConfirmRawTransaction(conn, tx.serialize()),
    { attempts: 3 }
  )
  .catch(async (e) => {
    firewall.onRpcFail('transfer failure');
    await redis.publish(
      'nexus.events',
      JSON.stringify({
        event: 'transfer_failure',
        from: fromKp.publicKey.toBase58(),
        to: destPk.toBase58(),
        error: e.message
      })
    );
    throw e;
  });
}

// ---------- burn + dev helper --------------------------------------
export async function burnAndDev(fromKp, lamports, pctBurn) {
  const burnLam = Math.floor(lamports * pctBurn);
  const devLam  = lamports - burnLam;

  await transfer(NXR_MINT, fromKp, BURN_WALLET, burnLam);
  await transfer(NXR_MINT, fromKp, DEV_WALLET.publicKey, devLam);

  console.log(
    `[BURN] ${(burnLam / 1e9).toFixed(3)} NXR | [DEV] ${(devLam / 1e9).toFixed(3)} NXR`
  );
}

// ---------- balance refresh (poll) ---------------------------------
export async function refreshBalances(user, agentMintPk) {
  const sol = await conn.getBalance(user.wallet.publicKey) / LAMPORTS_PER_SOL;
  const ata = getAssociatedTokenAddressSync(
    agentMintPk,
    user.wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  const info = await conn.getAccountInfo(ata);
  const agentLamports = info
    ? info.data.readBigUInt64LE(64)   // tokenAmount.amount (raw)
    : 0n;

  return { sol, agentLamports: Number(agentLamports) };
}

// ---------- live watchers (SOL + token) ----------------------------
const subscribed = new Set();
export function watchDeposits(users, agentMintPk, onUpdate) {
  users.forEach(async (u, handle) => {
    if (subscribed.has(handle)) return;
    subscribed.add(handle);

    // 1. SOL changes
    conn.onAccountChange(
      u.wallet.publicKey,
      async () => {
        const { sol } = await refreshBalances(u, agentMintPk);
        u.sol = sol;
        onUpdate(handle, u);
      },
      'confirmed'
    );

    // 2. Token changes
    const ata = getAssociatedTokenAddressSync(
      agentMintPk,
      u.wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    conn.onAccountChange(
      ata,
      async () => {
        const { agentLamports } = await refreshBalances(u, agentMintPk);
        u.tierBal = agentLamports;
        onUpdate(handle, u);
      },
      'confirmed'
    );
  });
}
