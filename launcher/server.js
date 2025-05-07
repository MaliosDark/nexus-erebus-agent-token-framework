// /launcher/server.js

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import bodyParser from 'body-parser';
import { createClient } from 'redis';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { randomBytes } from 'crypto';
import { firewall } from '../firewall.js';
import {
  Connection,
  PublicKey,
  Keypair,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';
// Import Raydium SDK as a default CJS module, then destructure:
import raydiumSdk from '@raydium-io/raydium-sdk-v2';
const {
  PlatformConfig,
  createLaunchpadPool,
  buyLaunchpadToken,
  sellLaunchpadToken,
  TxVersion,
  Curve,
} = raydiumSdk;

/** ENV **/
const {
    RPC_URL,
    REDIS_URL,
    PLATFORM_PRIVATE_KEY,
    DEV_LAUNCHPAD_PROGRAM: LAUNCHPAD_PROGRAM,
    IMAGE_API_ROOT,
    METADATA_BASE_URL,
    RECAPTCHA_SECRET,
    BONDING_CURVE,
    PORT = 3989,
    CORS_ORIGIN = '*',
  } = process.env;
  
  // CORE required vars
  const missingCore = [];
  if (!RPC_URL)                   missingCore.push('RPC_URL');
  if (!REDIS_URL)                 missingCore.push('REDIS_URL');
  if (!PLATFORM_PRIVATE_KEY)      missingCore.push('PLATFORM_PRIVATE_KEY');
  if (!LAUNCHPAD_PROGRAM)         missingCore.push('DEV_LAUNCHPAD_PROGRAM');
  if (!IMAGE_API_ROOT)            missingCore.push('IMAGE_API_ROOT');
  
  if (missingCore.length) {
    console.error('❌ Missing required .env vars (core):', missingCore.join(', '));
    process.exit(1);
  }
  console.log('✅ All core .env vars present.');
  
  // OPTIONAL vars with defaults or disabled behavior
  if (!METADATA_BASE_URL) {
    console.warn('⚠️ METADATA_BASE_URL not set, defaulting to https://myplatform.io');
  }
  if (!RECAPTCHA_SECRET) {
    console.warn('⚠️ RECAPTCHA_SECRET not set, captcha will be disabled');
  } else {
    console.log('✅ reCAPTCHA enabled.');
  }
  
  // Show the rest of your config for visibility
  console.log(`ℹ️  Using BONDING_CURVE: ${BONDING_CURVE || 'LINEAR (default)'}`);
  console.log(`ℹ️  CORS_ORIGIN:       ${CORS_ORIGIN}`);
  console.log(`ℹ️  Server PORT:       ${PORT}`);
  

/** INIT **/
const app = express();

// SECURITY MIDDLEWARE
app.use(helmet());
app.use(cors({ origin: CORS_ORIGIN, methods: ['GET','POST'], credentials: true }));

// Body parsing
app.use(bodyParser.json());

// Redis client
const redis = createClient({ url: REDIS_URL });
redis.connect().catch(err => {
  console.error('Redis connection failed:', err);
  firewall.onCritical('Redis connect failure');
  process.exit(1);
});

// Solana connection
const connection = new Connection(RPC_URL, 'confirmed');

// Platform keypair (accepts Base58 or JSON‐array)
let PLATFORM_KP;
try {
  const keyRaw = PLATFORM_PRIVATE_KEY.trim();
  if (keyRaw.startsWith('[')) {
    // JSON array of bytes format
    const arr = JSON.parse(keyRaw);
    PLATFORM_KP = Keypair.fromSecretKey(Uint8Array.from(arr));
  } else {
    // Base58 string format
    PLATFORM_KP = Keypair.fromSecretKey(bs58.decode(keyRaw));
  }
} catch (err) {
  console.error('❌ Invalid PLATFORM_PRIVATE_KEY. Must be a Base58 string or a JSON array of bytes.');
  process.exit(1);
}
const PLATFORM_PUB = PLATFORM_KP.publicKey;


// Bonding curve type
const CURVE_TYPE = {
  LINEAR:      Curve.Linear,
  EXPONENTIAL: Curve.Exponential,
  LOGARITHMIC: Curve.Logarithmic,
}[BONDING_CURVE] || Curve.Linear;

/** CAPTCHA MIDDLEWARE **/
async function verifyRecaptcha(token) {
  const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type':'application/x-www-form-urlencoded' },
    body: `secret=${encodeURIComponent(RECAPTCHA_SECRET)}&response=${encodeURIComponent(token)}`,
  });
  const json = await res.json();
  return json.success === true && (json.score ?? 0) >= 0.5;
}

async function captchaMiddleware(req, res, next) {
  try {
    const ip          = req.ip;
    const headerToken = req.headers['x-captcha-token'];
    const attempts    = parseInt(await redis.get(`captcha:fail:${ip}`)) || 0;
    const required    = attempts > 5 ? 2 : 1;

    if (!headerToken) {
      return res.status(429).json({ error: `Captcha required: solve ${required}` });
    }

    const ok = await verifyRecaptcha(headerToken);
    if (!ok) {
      await redis.incr(`captcha:fail:${ip}`);
      await redis.expire(`captcha:fail:${ip}`, 3600);
      return res.status(429).json({ error: `Captcha failed: solve ${required}` });
    }

    // success → reset counter
    await redis.del(`captcha:fail:${ip}`);
    next();
  } catch (err) {
    firewall.onError(`Captcha middleware error: ${err.message}`);
    return res.status(500).json({ error: 'Captcha internal error' });
  }
}

/** API key logic **/
async function generateApiKey(userId) {
  const key = randomBytes(32).toString('hex');
  await redis.set(`apikey:${userId}`, key, { EX: 7200 });
  return key;
}

async function validateApiKey(req, res, next) {
  const userId = req.headers['x-user-id'];
  const key    = req.headers['x-api-key'];
  if (!userId || !key) {
    firewall.onSpam(`Missing API headers`);
    return res.status(403).send('Forbidden');
  }
  const stored = await redis.get(`apikey:${userId}`);
  if (stored !== key) {
    firewall.onSpam(`Invalid API key for ${userId}`);
    return res.status(403).send('Forbidden');
  }
  req.userId = userId;
  next();
}

/** Image gen **/
async function generateImage(prompt) {
  const fd  = new FormData();
  fd.append('texto', prompt);
  const res = await fetch(`${IMAGE_API_ROOT}/obtener_imagen`, { method:'POST', body:fd });
  if (!res.ok) {
    const msg = `Image API ${res.statusText}`;
    firewall.onError(msg);
    throw new Error(msg);
  }
  const filename = (await res.text()).split('/').pop();
  return `${IMAGE_API_ROOT}/images/${filename}`;
}

/** Helpers **/
async function getUserKP(userId) {
  const j = await redis.get(`wallet:${userId}`);
  if (!j) {
    firewall.onError(`Wallet not found for ${userId}`);
    throw new Error('Wallet not found');
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(j)));
}

/** Public: get API key **/
app.post('/get-api-key', captchaMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error:'userId required' });
    const apiKey = await generateApiKey(userId);
    res.json({ userId, apiKey, expiresIn:7200 });
  } catch (err) {
    firewall.onError(`get-api-key: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Public endpoint: get metadata from token
app.get('/token/:mint', async (req, res) => {
  try {
    const meta = await redis.hGetAll(`tokenmeta:${req.params.mint}`);
    if (!meta || Object.keys(meta).length === 0) {
      return res.status(404).json({ error:'Not found' });
    }
    res.json(meta);
  } catch (err) {
    firewall.onError(`GET /token/:mint: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** Protected below **/
app.use(captchaMiddleware);
app.use(validateApiKey);

/** 1. Create SPL Token + image + metadata **/
app.post('/create-token', async (req, res) => {
  try {
    const { decimals, supply, tokenName } = req.body;
    const userKP = await getUserKP(req.userId);

    // mint SPL token
    const mint = await createMint(connection, userKP, userKP.publicKey, null, decimals);
    const ata  = await getOrCreateAssociatedTokenAccount(
      connection, userKP, mint, userKP.publicKey
    );
    await mintTo(
      connection, userKP, mint, ata.address, userKP,
      supply * 10 ** decimals
    );

    // generate and store logo
    const imageUrl = await generateImage(`Logo for token ${tokenName}`);
    const website  = `${METADATA_BASE_URL}/token/${mint.toBase58()}`;

    await redis.hSet(`tokenmeta:${mint.toBase58()}`, {
      name:    tokenName,
      image:   imageUrl,
      website,
    });

    res.json({
      mint:    mint.toBase58(),
      account: ata.address.toBase58(),
      imageUrl,
      website,
    });
  } catch (err) {
    firewall.onError(`create-token: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** 2. Create Launchpad Pool **/
app.post('/create-pool', async (req, res) => {
  try {
    const {
      tokenAMint, tokenBMint,
      supply, totalSellA, totalFundRaisingB,
      cliffPeriod, unlockPeriod, startDelay
    } = req.body;
    const userKP = await getUserKP(req.userId);

    const platformConfig = new PlatformConfig({
      owner:         PLATFORM_PUB,
      feeRate:       300,
      creatorScale:  3000,
      platformScale: 5000,
      burnScale:     2000,
    });

    const now = Math.floor(Date.now()/1000);
    const poolParams = {
      tokenAMint:          new PublicKey(tokenAMint),
      tokenBMint:          new PublicKey(tokenBMint),
      decimals:            6,
      supply,
      totalSellA,
      totalFundRaisingB,
      totalLockedAmount:   supply,
      cliffPeriod,
      unlockPeriod,
      startTime:           now + startDelay,
      platformID:          PLATFORM_PUB,
      platformFeeRate:     300,
      migrateType:         'cpmm',
      curveType:           CURVE_TYPE,
    };

    const tx = await createLaunchpadPool({
      connection,
      wallet:      userKP,
      poolParams,
      platformConfig,
      programId:   new PublicKey(LAUNCHPAD_PROGRAM),
      txVersion:   TxVersion.V0,
    });

    const sig = await sendAndConfirmTransaction(connection, tx, [ userKP ]);
    res.json({ success: true, signature: sig });
  } catch (err) {
    firewall.onError(`create-pool: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** 3. Buy from Launchpad **/
app.post('/buy-token', async (req, res) => {
  try {
    const { poolId, amountB } = req.body;
    const userKP = await getUserKP(req.userId);

    const ata = await getOrCreateAssociatedTokenAccount(
      connection, userKP, new PublicKey(poolId), userKP.publicKey
    );
    const tx = await buyLaunchpadToken({
      connection,
      wallet:         userKP,
      poolId:         new PublicKey(poolId),
      amountB,
      tokenAAccount:  ata.address,
      programId:      new PublicKey(LAUNCHPAD_PROGRAM),
      txVersion:      TxVersion.V0,
    });
    const sig = await sendAndConfirmTransaction(connection, tx, [ userKP ]);
    res.json({ success: true, signature: sig });
  } catch (err) {
    firewall.onError(`buy-token: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** 4. Sell back to Launchpad **/
app.post('/sell-token', async (req, res) => {
  try {
    const { poolId, amountA } = req.body;
    const userKP = await getUserKP(req.userId);

    const ata = await getOrCreateAssociatedTokenAccount(
      connection, userKP, new PublicKey(poolId), userKP.publicKey
    );
    const tx = await sellLaunchpadToken({
      connection,
      wallet:         userKP,
      poolId:         new PublicKey(poolId),
      amountA,
      tokenAAccount:  ata.address,
      programId:      new PublicKey(LAUNCHPAD_PROGRAM),
      txVersion:      TxVersion.V0,
    });
    const sig = await sendAndConfirmTransaction(connection, tx, [ userKP ]);
    res.json({ success: true, signature: sig });
  } catch (err) {
    firewall.onError(`sell-token: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** 5. Full Launch (Token + Pool) **/
app.post('/launch-token', async (req, res) => {
  try {
    const {
      decimals, supply, tokenName,
      tokenBMint, totalRaiseB,
      cliffPeriod, unlockPeriod, startDelay
    } = req.body;
    const userKP = await getUserKP(req.userId);

    // 5.1 Create SPL token + metadata
    const mint = await createMint(connection, userKP, userKP.publicKey, null, decimals);
    const ata  = await getOrCreateAssociatedTokenAccount(
      connection, userKP, mint, userKP.publicKey
    );
    await mintTo(
      connection, userKP, mint, ata.address, userKP,
      supply * 10 ** decimals
    );

    const imageUrl = await generateImage(`Logo for ${tokenName}`);
    const website  = `${METADATA_BASE_URL}/token/${mint.toBase58()}`;
    await redis.hSet(`tokenmeta:${mint.toBase58()}`, {
      name:    tokenName,
      image:   imageUrl,
      website,
    });

    // 5.2 Create pool
    const platformConfig = new PlatformConfig({
      owner:          PLATFORM_PUB,
      feeRate:        300,
      creatorScale:   6000,
      platformScale:  2500,
      burnScale:      1500,
    });
    const now = Math.floor(Date.now()/1000);
    const poolParams = {
      tokenAMint:          mint,
      tokenBMint:          new PublicKey(tokenBMint),
      decimals,
      supply,
      totalSellA:          supply,
      totalFundRaisingB:   totalRaiseB,
      totalLockedAmount:   supply,
      cliffPeriod,
      unlockPeriod,
      startTime:           now + startDelay,
      platformID:          PLATFORM_PUB,
      platformFeeRate:     300,
      migrateType:         'cpmm',
      curveType:           CURVE_TYPE,
    };

    const tx = await createLaunchpadPool({
      connection,
      wallet:      userKP,
      poolParams,
      platformConfig,
      programId:   new PublicKey(LAUNCHPAD_PROGRAM),
      txVersion:   TxVersion.V0,
    });
    const sig = await sendAndConfirmTransaction(connection, tx, [ userKP ]);

    res.json({
      success:       true,
      mint:          mint.toBase58(),
      account:       ata.address.toBase58(),
      imageUrl,
      website,
      poolSignature: sig
    });
  } catch (err) {
    firewall.onError(`launch-token: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** Global error handler **/
app.use((err, req, res, next) => {
  firewall.onError(`Unhandled: ${err.message}`);
  res.status(500).json({ error: err.message });
});

/** Start server **/
app.listen(PORT, () => {
  console.log(`🚀 Launcher API running on http://localhost:${PORT}`);
});
