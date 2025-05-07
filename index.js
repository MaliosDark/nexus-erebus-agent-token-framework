// index.js  –  Nexus Agent boot & service launcher
import 'dotenv/config';
import { spawn } from 'child_process';
import { TelegramClient } from './telegram-client.js';
import { TwitterClient }  from './twitter-client.js';
import {
  launchTokenInternal,
  generateLaunchConfig as launchConfigInternal,
  generateImage        as previewImage
} from './utils-launcher.js';

import {
  initializeUsers,
  walletOf,
  balanceOf,
  toggleAuto,
  setRisk,
  handleMessage,
  fetchSolPrice,
  getPortfolio,
  recall as getHistory
} from './commands.js';

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
startService('Launcher', 'launcher/server.js');

// ─── Initialize users ─────────────────────────────────────────────
await initializeUsers();

const USE_TELEGRAM = process.env.USE_TELEGRAM !== 'false';
const USE_TWITTER  = process.env.USE_TWITTER  === 'true';

// ─── Instantiate clients ──────────────────────────────────────────
// give TelegramClient a longer handler timeout for AI calls
const tg = USE_TELEGRAM ? new TelegramClient({ handlerTimeout: 30_000 }) : null;
const tw = USE_TWITTER  ? new TwitterClient()                        : null;

// ─── Telegram setup ────────────────────────────────────────────────
if (USE_TELEGRAM) {
  tg.setHelpers({
    walletOf,
    balanceOf,
    fetchSolPrice,
    getPortfolio,
    getHistory,
    ensureUser: handle => {},           // no-op stub
    saveChatId: (handle, chatId) => {}, // wired in commands.js
    toggleAuto,
    setRisk,
    generateLaunchConfig: launchConfigInternal,
    launchToken:         launchTokenInternal,
    previewImage,                        // ⚡ add previewImage helper
  });
  await tg.init(handleMessage);
  console.log('[BOOT] Telegram ON');
}

// ─── Twitter setup ─────────────────────────────────────────────────
if (USE_TWITTER) {
  await tw.init();
  tw.setHelpers({ walletOf, balanceOf });
  tw.onMessage?.(twMsg => {
    handleMessage({
      platform: 'twitter',
      handle:   twMsg.handle.toLowerCase(),
      text:     twMsg.text,
      reply:    txt => twMsg.reply(txt)
    });
  });
  console.log('[BOOT] Twitter ON');
}

// ─── Final readiness log ───────────────────────────────────────────
console.log(
  `[${process.env.AGENT_NAME}] ready → ${
    [USE_TELEGRAM && 'Telegram', USE_TWITTER && 'Twitter']
      .filter(Boolean)
      .join(' + ')
  }`
);
