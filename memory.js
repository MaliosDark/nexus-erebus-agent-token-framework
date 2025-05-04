// memory.js  — basic JSON memory per agent
//------------------------------------------------
import fs from 'fs';
import 'dotenv/config';
import redis from './redisClient.js';

const STREAM_PREFIX = 'memory:';
const MEMORY_TTL    = 24 * 60 * 60; // 1 day in seconds

const MEM_FILE = process.env.AGENT_MEMORY_FILE;
const data = fs.existsSync(MEM_FILE)
  ? JSON.parse(fs.readFileSync(MEM_FILE,'utf8'))
  : {convos: []};

  export async function remember(entry) { // { handle, text, ts }
    const key = STREAM_PREFIX + entry.handle;
    await redis.xadd(key, '*', 'text', entry.text, 'ts', entry.ts.toString());
    await redis.expire(key, MEMORY_TTL);
  }
  
  export async function recall(handle, limit = 5) {
    const key = STREAM_PREFIX + handle;
    const raw = await redis.xrevrange(key, '+', '-', 'COUNT', limit);
    const entries = raw.map(([id, fields]) => {
      const obj = {};
      for (let i = 0; i < fields.length; i += 2) {
        obj[fields[i]] = fields[i + 1];
      }
      return obj;
    });
    return entries.reverse(); // oldest first
  }