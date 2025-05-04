// db.js  –  LowDB wrapper (users.json)
import { Low }          from 'lowdb';
import { JSONFile }     from 'lowdb/node';
import { nanoid }       from 'nanoid';
import { join, dirname} from 'path';
import { fileURLToPath } from 'url';
import redis from './redisClient.js';


// ── __dirname fix for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── DB initialise
const file     = join(__dirname, 'users.json');
const adapter  = new JSONFile(file);
export const db = new Low(adapter);
const USERS_SET = 'users'; 

await db.read();
if (!db.data || typeof db.data !== 'object') db.data = { users: [] };
if (!Array.isArray(db.data.users))           db.data.users = [];
await db.write();

// ───────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────
export async function upsertUser(handle, data) {
  const key = `user:${handle}`;
  await redis.sadd(USERS_SET, handle);
  await redis.hset(key, data);
}

export async function getUser(handle) {
  const key = `user:${handle}`;
  const data = await redis.hgetall(key);
  return Object.keys(data).length ? data : null;
}

export async function getAllUsers() {
  return await redis.smembers(USERS_SET);
}