// utils-token.js  — SPL token utilities (with Redis caching)
import { conn } from './utils-solana.js';
import {
  PublicKey,
  Transaction,
  sendAndConfirmRawTransaction
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createTransferCheckedInstruction
} from '@solana/spl-token';
import redis from './redisClient.js';
import { withRetry } from './retry.js';

const DECIMALS_TTL = 300; // seconds

function decimalsCacheKey(mint) {
  return `decimals:${mint.toBase58()}`;
}

/**
 * Get token decimals, cached in Redis for DECIMALS_TTL seconds.
 * @param {PublicKey} mint
 * @returns {Promise<number>}
 */
export async function getDecimals(mint) {
  const key = decimalsCacheKey(mint);
  const cached = await redis.get(key);
  if (cached) return parseInt(cached, 10);

  const info = await conn.getParsedAccountInfo(mint);
  const decimals = info.value.data.parsed.info.decimals;
  await redis.setEx(key, DECIMALS_TTL, decimals.toString());
  return decimals;
}

/**
 * Get the associated token account for a mint & owner.
 * @param {PublicKey} mint
 * @param {PublicKey} owner
 * @returns {PublicKey}
 */
export function getATA(mint, owner) {
  return getAssociatedTokenAddressSync(
    mint,
    owner,
    false,
    TOKEN_2022_PROGRAM_ID
  );
}

/**
 * Fetch SPL token balance for a given owner.
 * @param {PublicKey} owner
 * @param {PublicKey} mint
 * @returns {Promise<number>}
 */
export async function getTokenBalance(owner, mint) {
  const ata = getATA(mint, owner);
  const info = await conn.getAccountInfo(ata);
  if (!info) return 0;
  const rawAmount = info.data.readBigUInt64LE(64);
  const decimals = await getDecimals(mint);
  return Number(rawAmount) / 10 ** decimals;
}

/**
 * Transfer SPL tokens (handles ATA, decimals, retry).
 * @param {PublicKey} mint 
 * @param {Keypair} fromKeypair 
 * @param {PublicKey} toPubkey 
 * @param {number} amount 
 * @returns {Promise<string>} transaction signature
 */
export async function transferToken(mint, fromKeypair, toPubkey, amount) {
  const fromATA = getATA(mint, fromKeypair.publicKey);
  const toATA   = getATA(mint, toPubkey);

  const decimals = await getDecimals(mint);
  const raw      = Math.floor(amount * 10 ** decimals);

  const ix = createTransferCheckedInstruction(
    fromATA,
    mint,
    toATA,
    fromKeypair.publicKey,
    raw,
    decimals
  );

  const tx = new Transaction().add(ix);
  tx.feePayer      = fromKeypair.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(fromKeypair);

  return await withRetry(
    () => sendAndConfirmRawTransaction(conn, tx.serialize()),
    { attempts: 3 }
  );
}
