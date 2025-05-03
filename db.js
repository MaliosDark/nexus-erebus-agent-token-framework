// db.js  –  LowDB wrapper (users.json)
import { Low }          from 'lowdb';
import { JSONFile }     from 'lowdb/node';
import { nanoid }       from 'nanoid';
import { join, dirname} from 'path';
import { fileURLToPath } from 'url';

// ── __dirname fix for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── DB initialise
const file     = join(__dirname, 'users.json');
const adapter  = new JSONFile(file);
export const db = new Low(adapter);

await db.read();
if (!db.data || typeof db.data !== 'object') db.data = { users: [] };
if (!Array.isArray(db.data.users))           db.data.users = [];
await db.write();

// ───────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────
export function upsertUser(handle, data){
  const idx = db.data.users.findIndex(u => u.handle === handle);
  if (idx !== -1)
    db.data.users[idx] = { ...db.data.users[idx], ...data };
  else
    db.data.users.push({ id: nanoid(), handle, ...data });

  db.write();         // persist
}

export function getUser(handle){
  return db.data.users.find(u => u.handle === handle);
}
