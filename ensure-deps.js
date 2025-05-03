// ensure-deps.js
import fs from 'fs';
import { execSync } from 'child_process';

const repo   = 'https://github.com/elizaOS/agent-twitter-client.git';
const folder = './agent-twitter-client';
const pkg    = `${folder}/package.json`;
const nodeMod= `${folder}/node_modules`;

try {
  // Clone if missing
  if (!fs.existsSync(folder)) {
    console.log('📦 agent-twitter-client not found — cloning…');
    execSync(`git clone ${repo}`, { stdio: 'inherit' });
  }

  // Validate package.json
  if (!fs.existsSync(pkg)) {
    console.error('❌ Clone failed or incomplete. Please check your connection.');
    process.exit(1);
  }

  // Skip install if node_modules already exists
  if (!fs.existsSync(nodeMod)) {
    console.log('🔧 Installing agent-twitter-client dependencies...');
    execSync(`cd ${folder} && npm install`, { stdio: 'inherit' });
  } else {
    console.log('✅ agent-twitter-client already installed.');
  }

  // Link to main node_modules if needed
  const linked = fs.existsSync('./node_modules/agent-twitter-client');
  if (!linked) {
    console.log('🔗 Linking into node_modules…');
    execSync(`npm install ${folder}`, { stdio: 'inherit' });
  }

  console.log('✅ Dependencies ready.');
  
} catch (e) {
  console.error('🔥 Error in ensure-deps:', e.message);
  process.exit(1);
}
