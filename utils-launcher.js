// utils-launcher.js — Internal integration of the Launcher API (English)
// --------------------------------------------------------------------

import 'dotenv/config'
import bs58 from 'bs58'
import fetch from 'node-fetch'
import FormData from 'form-data'
import { createClient } from 'redis'
import {
  Connection,
  PublicKey,
  Keypair,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token'
import raydiumSdk from '@raydium-io/raydium-sdk-v2'
import { firewall } from './firewall.js'

const {
  RPC_URL,
  REDIS_URL,
  PLATFORM_PRIVATE_KEY,
  DEV_LAUNCHPAD_PROGRAM: LAUNCHPAD_PROGRAM,
  IMAGE_API_ROOT,
  METADATA_BASE_URL,
  BONDING_CURVE,
  OLLAMA_URL,
  OLLAMA_MODEL,
  // vesting & raise from env
  LAUNCH_TOTAL_RAISE_SOL,
  LAUNCH_CLIFF_PERIOD,
  LAUNCH_UNLOCK_PERIOD,
  LAUNCH_START_DELAY,
} = process.env

// Native SOL mint for fundraising
const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112')

// ── Redis + Solana init
const redis = createClient({ url: REDIS_URL })
redis.connect().catch(err => { throw err })
const connection = new Connection(RPC_URL, 'confirmed')

// ── Platform Keypair
let PLATFORM_KP
const rawKey = PLATFORM_PRIVATE_KEY.trim()
if (rawKey.startsWith('[')) {
  PLATFORM_KP = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey)))
} else {
  PLATFORM_KP = Keypair.fromSecretKey(bs58.decode(rawKey))
}
const PLATFORM_PUB = PLATFORM_KP.publicKey

// ── Raydium bonding curve config
const { Curve, PlatformConfig, createLaunchpadPool, TxVersion } = raydiumSdk
const CURVE_TYPE = {
  LINEAR:      Curve.Linear,
  EXPONENTIAL: Curve.Exponential,
  LOGARITHMIC: Curve.Logarithmic,
}[BONDING_CURVE] || Curve.Linear

// ── Step 1: Ask Ollama for a logo description based on tokenName
async function generateImageDescription(tokenName) {
  const prompt = `
You are a creative branding assistant.
Provide a vivid, concise description for a meme character to represent the meme token named "${tokenName}".
Respond with nothing but the plain text description.
  `.trim()

  const res = await fetch(OLLAMA_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  })
  if (!res.ok) {
    const msg = `Ollama API ${res.statusText}`
    firewall.onError(msg)
    throw new Error(msg)
  }
  const { response } = await res.json()
  return response.trim()
}

// ── Step 2: Send that description to your external image API
export async function generateImage(prompt) {
  const fd = new FormData()
  fd.append('texto', prompt)
  const res = await fetch(`${IMAGE_API_ROOT}/obtener_imagen`, {
    method: 'POST',
    body:   fd,
  })
  if (!res.ok) {
    const msg = `Image API ${res.statusText}`
    firewall.onError(msg)
    throw new Error(msg)
  }
  const filename = (await res.text()).split('/').pop()
  return `${IMAGE_API_ROOT}/images/${filename}`
}

/**
 * AI‐powered helper: generate Raydium launch parameters via Ollama,
 * but vest & raise come from env, not AI.
 * Still pre‐generates a mint keypair so you see the tokenMint in advance.
 */
export async function generateLaunchConfig(userId) {
  const prompt = `
You are a Meme Token Launchpad configuration generator.
You only fundraise in SOL, never USDC.
Generate a fun meme token viral, output exactly one JSON object with these fields:
  - decimals (integer always 6)
  - supply (integer)
  - tokenName (string)
Respond with nothing but the raw JSON object.
`.trim()

  // 1) ask AI only for decimals, supply, tokenName
  const res  = await fetch(OLLAMA_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  })
  if (!res.ok) {
    const msg = `Ollama API ${res.statusText}`
    firewall.onError(msg)
    throw new Error(msg)
  }
  const { response } = await res.json()
  const raw = response.trim()

  // 2) extract & clean JSON
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error(`AI did not return a JSON object:\n${raw}`)
  let jsonText = raw.slice(start, end + 1)
    .replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')

  let aiCfg
  try {
    aiCfg = JSON.parse(jsonText)
  } catch (err) {
    throw new Error(`Failed to parse AI response: ${err.message}\n${jsonText}`)
  }

  // 3) pre‐generate a mint keypair
  const previewPair = Keypair.generate()

  // 4) merge AI + env
  return {
    decimals:     aiCfg.decimals,
    supply:       aiCfg.supply,
    tokenName:    aiCfg.tokenName,
    tokenMint:    previewPair.publicKey.toBase58(),
    tokenBMint:   SOL_MINT.toBase58(),
    totalRaiseB:  +LAUNCH_TOTAL_RAISE_SOL,
    cliffPeriod:  +LAUNCH_CLIFF_PERIOD,
    unlockPeriod: +LAUNCH_UNLOCK_PERIOD,
    startDelay:   +LAUNCH_START_DELAY,
  }
}

/**
 * Mint a new SPL token and create a Raydium Launchpad pool.
 * @param params {
 *   decimals: number,
 *   supply: number,
 *   tokenName: string,
 *   tokenMint?: string,      // preview only
 *   tokenBMint: string,
 *   totalRaiseB: number,
 *   cliffPeriod: number,
 *   unlockPeriod: number,
 *   startDelay: number
 * }
 * @param userId  string  user handle
 */
export async function launchTokenInternal(params, userId) {
  // 1) fetch user keypair
  const walletJson = await redis.get(`wallet:${userId}`)
  if (!walletJson) {
    firewall.onError(`Wallet not found for ${userId}`)
    throw new Error('Wallet not found')
  }
  const userKP = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(walletJson)))

  // 2) mint token + supply
  const mint = await createMint(
    connection,
    userKP,
    userKP.publicKey,
    null,
    params.decimals
  )
  const ata = await getOrCreateAssociatedTokenAccount(
    connection, userKP, mint, userKP.publicKey
  )
  await mintTo(
    connection, userKP,
    mint, ata.address, userKP,
    params.supply * 10 ** params.decimals
  )

  // 3) generate logo description via Ollama, then image
  const logoDesc = await generateImageDescription(params.tokenName)
  const imageUrl = await generateImage(logoDesc)
  const website  = `${METADATA_BASE_URL}/token/${mint.toBase58()}`

  await redis.hSet(`tokenmeta:${mint.toBase58()}`, {
    name:    params.tokenName,
    image:   imageUrl,
    website,
  })

  // 4) create Raydium pool
  const platformConfig = new PlatformConfig({
    owner:         PLATFORM_PUB,
    feeRate:       300,
    creatorScale:  6000,
    platformScale: 2500,
    burnScale:     1500,
  })
  const now = Math.floor(Date.now() / 1000)
  const poolParams = {
    tokenAMint:        mint,
    tokenBMint:        new PublicKey(params.tokenBMint),
    decimals:          params.decimals,
    supply:            params.supply,
    totalSellA:        params.supply,
    totalFundRaisingB: params.totalRaiseB,
    totalLockedAmount: params.supply,
    cliffPeriod:       params.cliffPeriod,
    unlockPeriod:      params.unlockPeriod,
    startTime:         now + params.startDelay,
    platformID:        PLATFORM_PUB,
    platformFeeRate:   300,
    migrateType:       'cpmm',
    curveType:         CURVE_TYPE,
  }

  const tx = await createLaunchpadPool({
    connection,
    wallet:      userKP,
    poolParams,
    platformConfig,
    programId:   new PublicKey(LAUNCHPAD_PROGRAM),
    txVersion:   TxVersion.V0,
  })
  const poolSignature = await sendAndConfirmTransaction(connection, tx, [userKP])

  return {
    mint:          mint.toBase58(),
    account:       ata.address.toBase58(),
    imageUrl,
    website,
    poolSignature,
  }
}
