// db.js — Redis‑only user store with AES‑256‑GCM wallet encryption
// ------------------------------------------------------------------
// REQUIRE: WALLET_CIPHER_KEY (64‑char hex) in .env
// ------------------------------------------------------------------

import crypto from 'crypto';
import 'dotenv/config';
import redis  from './redisClient.js';

// ── Constants ───────────────────────────────────────────────────────
const USERS_SET  = 'users';                          // Set → every handle
const CIPHER_KEY = Buffer.from(
  process.env.WALLET_CIPHER_KEY || '',
  'hex'
);

if (CIPHER_KEY.length !== 32) {
  console.error(
    '[SEC] WALLET_CIPHER_KEY must be 32‑byte hex (32 bytes = 64 hex chars)'
  );
  process.exit(1);
}

// ── AES‑256‑GCM helpers ─────────────────────────────────────────────
/* Stored format (base64):
     12‑byte IV | 16‑byte TAG | CIPHER
   and we prefix the Redis field with "enc:" so we can detect plaintext.
*/
function encrypt(buf) {
  const iv   = crypto.randomBytes(12);
  const enc  = crypto.createCipheriv('aes-256-gcm', CIPHER_KEY, iv);
  const cipher = Buffer.concat([enc.update(buf), enc.final()]);
  const tag    = enc.getAuthTag();
  return Buffer.concat([iv, tag, cipher]).toString('base64');
}

function decrypt(b64) {
  const raw = Buffer.from(b64, 'base64');
  const iv  = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const cip = raw.subarray(28);
  const dec = crypto.createDecipheriv('aes-256-gcm', CIPHER_KEY, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(cip), dec.final()]); // Buffer
}

// ── Core helpers ────────────────────────────────────────────────────

/**
 * Upsert any user fields.  
 * If `wallet` is supplied in **plaintext**, it is encrypted transparently.
 */
export async function upsertUser(handle, data = {}) {
  const key = `user:${handle}`;

  // chatId is public → store as‑is
  if (data.chatId) {
    await redis.hset(key, 'chatId', data.chatId);
    delete data.chatId;
  }

  // Encrypt wallet if it looks plaintext
  if (data.wallet && !data.wallet.startsWith('enc:')) {
    data.wallet = 'enc:' + encrypt(Buffer.from(data.wallet));
  }

  await redis.sadd(USERS_SET, handle);
  if (Object.keys(data).length) await redis.hset(key, data);
}

/**
 * Store / replace the secretKey for a handle (expects Uint8Array).
 * The secret is encrypted and the plaintext is wiped from memory.
 */
export async function setWalletSecret(handle, secretUint8Array) {
  // serialize first (Uint8Array → JSON string)
  const plainBuf = Buffer.from(
    JSON.stringify(Array.from(secretUint8Array))
  );

  const cipher = 'enc:' + encrypt(plainBuf);
  plainBuf.fill(0);                                    // zero plaintext

  const key = `user:${handle}`;
  await redis.sadd(USERS_SET, handle);
  await redis.hset(key, 'wallet', cipher);
}

/**
 * Return *public* user fields – **never** returns plaintext wallet.
 */
export async function getUser(handle) {
  const data = await redis.hgetall(`user:${handle}`);
  if (!Object.keys(data).length) return null;

  // Remove encrypted wallet before exposing
  delete data.wallet;
  return data;
}

/**
 * Get the decrypted (Uint8Array) secretKey only on demand.
 * Caller should overwrite / drop it ASAP.
 */
export async function getWalletSecret(handle) {
  const enc = await redis.hget(`user:${handle}`, 'wallet');
  if (!enc || !enc.startsWith('enc:')) return null;

  const plain = decrypt(enc.slice(4));                 // Buffer
  const secret = Uint8Array.from(JSON.parse(plain.toString()));
  plain.fill(0);                                       // wipe

  return secret;
}

/**
 * List all registered handles.
 */
export async function getAllUsers() {
  return redis.smembers(USERS_SET);
}
