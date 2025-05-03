// memory.js  — basic JSON memory per agent
//------------------------------------------------
import fs from 'fs';
import 'dotenv/config';

const MEM_FILE = process.env.AGENT_MEMORY_FILE;
const data = fs.existsSync(MEM_FILE)
  ? JSON.parse(fs.readFileSync(MEM_FILE,'utf8'))
  : {convos: []};

export function remember(entry){     // {handle, text, ts}
  data.convos.push(entry);
  fs.writeFileSync(MEM_FILE, JSON.stringify(data,null,2));
}
export function recall(handle, limit=5){
  return data.convos.filter(c=>c.handle===handle).slice(-limit);
}
