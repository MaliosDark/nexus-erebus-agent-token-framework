// check-env.js — Pre-flight checker for Nexus Agent Bot
// -------------------------------------------------------
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const REQUIRED_FILES = [
  'index.js',
  '.env',
  'package.json'
];

const REQUIRED_ENV_VARS = [
  'AGENT_NAME',
  'AGENT_MINT',
  'TIER_THRESHOLDS',
  'RPC',
  'NXR_MINT',
  'DEV_WALLET_SK',
  'TWITTER_USERNAME',
  'TWITTER_PASSWORD',
  'TELEGRAM_BOT_TOKEN',
  'OLLAMA_URL',
  'OLLAMA_MODEL'
];

let errors = 0;

// 🔍 Check required files
console.log('\n📁 Checking required files...');
for (const file of REQUIRED_FILES) {
  if (!fs.existsSync(file)) {
    console.error(`❌ Missing file: ${file}`);
    errors++;
  } else {
    console.log(`✅ Found: ${file}`);
  }
}

// 🔍 Check required ENV variables
console.log('\n🔐 Checking required environment variables...');
for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    console.error(`❌ Missing: ${key}`);
    errors++;
  } else {
    console.log(`✅ ${key}`);
  }
}

if (errors > 0) {
  console.error(`\n💥 Pre-flight failed with ${errors} error(s). Fix them before running the bot.\n`);
  process.exit(1);
} else {
  console.log('\n🚀 All good! Ready to run Nexus Agent.\n');
}
