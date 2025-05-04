// ensure-deps.js — Pre-flight checker for Nexus Agent Bot + Redis setup + overcommit & malloc fix
import fs from 'fs';
import { execSync } from 'child_process';

// agent-twitter-client settings
const twitterRepo     = 'https://github.com/elizaOS/agent-twitter-client.git';
const twitterFolder   = './agent-twitter-client';
const twitterPkg      = `${twitterFolder}/package.json`;
const twitterNodeMod  = `${twitterFolder}/node_modules`;

// redis settings
const redisRepo   = 'https://github.com/redis/redis.git';
const redisFolder = './redis';
const redisSrc    = `${redisFolder}/src/redis-server`;

try {
  // ── Enable vm.overcommit_memory ───────────────────────────────────
  console.log('🔧 Enabling vm.overcommit_memory=1 via sysctl...');
  try {
    execSync('sysctl -w vm.overcommit_memory=1', { stdio: 'inherit' });
  } catch (e) {
    console.warn(`⚠️ Could not set vm.overcommit_memory: ${e.message}`);
  }

  // ── agent-twitter-client ──────────────────────────────────────────
  if (!fs.existsSync(twitterFolder)) {
    console.log('📦 agent-twitter-client not found — cloning…');
    execSync(`git clone ${twitterRepo}`, { stdio: 'inherit' });
  }
  if (!fs.existsSync(twitterPkg)) {
    console.error('❌ Clone failed or incomplete. Please check your connection.');
    process.exit(1);
  }
  if (!fs.existsSync(twitterNodeMod)) {
    console.log('🔧 Installing agent-twitter-client dependencies…');
    execSync(`cd ${twitterFolder} && npm install`, { stdio: 'inherit' });
  } else {
    console.log('✅ agent-twitter-client already installed.');
  }
  if (!fs.existsSync('./node_modules/agent-twitter-client')) {
    console.log('🔗 Linking into node_modules…');
    execSync(`npm install ${twitterFolder}`, { stdio: 'inherit' });
  }

  // ── Redis server ─────────────────────────────────────────────────
  if (!fs.existsSync(redisFolder)) {
    console.log('📦 Redis not found — cloning…');
    execSync(`git clone ${redisRepo}`, { stdio: 'inherit' });
  }
  if (!fs.existsSync(redisSrc)) {
    console.log('🔨 Compiling Redis (using libc malloc to suppress jemalloc warning)…');
    execSync(`cd ${redisFolder} && make distclean && make MALLOC=libc`, { stdio: 'inherit' });
  } else {
    console.log('✅ Redis already compiled.');
  }

  console.log('🚀 Starting redis-server as daemon…');
  execSync(`${redisSrc} --daemonize yes`, { stdio: 'inherit' });

  console.log('✅ Dependencies ready (agent-twitter-client + Redis).');

} catch (e) {
  console.error('🔥 Error in ensure-deps:', e.message);
  process.exit(1);
}
