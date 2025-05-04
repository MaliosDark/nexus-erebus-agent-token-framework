// index.js  –  Nexus Agent boot & service launcher
import 'dotenv/config';
import { spawn } from 'child_process';
import { TelegramClient } from './telegram-client.js';
import { TwitterClient }  from './twitter-client.js';
import { initializeUsers, walletOf, balanceOf, toggleAuto, setRisk, handleMessage } from './commands.js';

// ─── Spawn & monitor child services ───────────────────────────────
function startService(name, script) {
  let proc;
  const start = () => {
    console.log(`[${name}] starting ${script}`);
    proc = spawn(process.execPath, [script], { stdio: 'inherit' });
    proc.on('exit', (code, signal) => {
      console.error(`[${name}] exited with ${code ?? signal}. Restarting in 5s…`);
      setTimeout(start, 5000);
    });
  };
  start();
}

startService('Metrics', 'metrics.js');
startService('Worker',  'worker.js');

// ─── Telegram + Twitter boot ──────────────────────────────────────
await initializeUsers();

const USE_TELEGRAM = process.env.USE_TELEGRAM !== 'false';
const USE_TWITTER  = process.env.USE_TWITTER  === 'true';

const tg = USE_TELEGRAM ? new TelegramClient() : null;
const tw = USE_TWITTER  ? new TwitterClient()  : null;

if (USE_TELEGRAM) {
  tg.setHelpers({
    walletOf,
    balanceOf,
    ensureUser : handle => {},         // not needed here
    toggleAuto,
    setRisk,
    saveChatId : (handle, chatId) => {} // wired up in commands.js
  });
  await tg.init(handleMessage);
  console.log('[BOOT] Telegram ON');
}

if (USE_TWITTER) {
  await tw.init();
  tw.setHelpers({ walletOf, balanceOf });
  tw.onMessage?.(twMsg => {
    handleMessage({
      platform: 'twitter',
      handle  : twMsg.handle.toLowerCase(),
      text    : twMsg.text,
      reply   : txt => twMsg.reply(txt)
    });
  });
  console.log('[BOOT] Twitter ON');
}

console.log(`[${process.env.AGENT_NAME}] ready → ${
  [USE_TELEGRAM && 'Telegram', USE_TWITTER && 'Twitter'].filter(Boolean).join(' + ')
}`);
