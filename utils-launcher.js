// utils-launcher.js — internal integration of the Launcher API
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
} = process.env

// Redis + Solana init
const redis     = createClient({ url: REDIS_URL })
redis.connect().catch(err => { throw err })
const connection = new Connection(RPC_URL, 'confirmed')

// Platform keypair
let PLATFORM_KP
const raw = PLATFORM_PRIVATE_KEY.trim()
if (raw.startsWith('[')) {
  PLATFORM_KP = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
} else {
  PLATFORM_KP = Keypair.fromSecretKey(bs58.decode(raw))
}
const PLATFORM_PUB = PLATFORM_KP.publicKey

// Curve
const { Curve, PlatformConfig, createLaunchpadPool, TxVersion } = raydiumSdk
const CURVE_TYPE = {
  LINEAR:      Curve.Linear,
  EXPONENTIAL: Curve.Exponential,
  LOGARITHMIC: Curve.Logarithmic,
}[BONDING_CURVE] || Curve.Linear

// Aux: genera logo
async function generateImage(prompt) {
  const fd = new FormData()
  fd.append('texto', prompt)
  const res = await fetch(`${IMAGE_API_ROOT}/obtener_imagen`, { method:'POST', body:fd })
  if (!res.ok) {
    const msg = `Image API ${res.statusText}`
    firewall.onError(msg)
    throw new Error(msg)
  }
  const filename = (await res.text()).split('/').pop()
  return `${IMAGE_API_ROOT}/images/${filename}`
}

/**
 * Lanza token + pool todo en Devnet **interno**
 * @param params  { decimals, supply, tokenName, tokenBMint, totalRaiseB, cliffPeriod, unlockPeriod, startDelay }
 * @param userId  string   handle del usuario
 */
export async function launchTokenInternal(params, userId) {
  // 1) Obtén Keypair del usuario
  const j = await redis.get(`wallet:${userId}`)
  if (!j) {
    firewall.onError(`Wallet not found for ${userId}`)
    throw new Error('Wallet not found')
  }
  const userKP = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(j)))

  // 2) Mint SPL token + metadata
  const mint = await createMint(connection, userKP, userKP.publicKey, null, params.decimals)
  const ata  = await getOrCreateAssociatedTokenAccount(
    connection, userKP, mint, userKP.publicKey
  )
  await mintTo(
    connection, userKP,
    mint, ata.address, userKP,
    params.supply * 10 ** params.decimals
  )

  const imageUrl = await generateImage(`Logo for ${params.tokenName}`)
  const website  = `${METADATA_BASE_URL}/token/${mint.toBase58()}`
  await redis.hSet(`tokenmeta:${mint.toBase58()}`, {
    name:    params.tokenName,
    image:   imageUrl,
    website,
  })

  // 3) Crear pool en Raydium
  const platformConfig = new PlatformConfig({
    owner:         PLATFORM_PUB,
    feeRate:       300,
    creatorScale:  6000,
    platformScale: 2500,
    burnScale:     1500,
  })
  const now = Math.floor(Date.now()/1000)
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
  const poolSignature = await sendAndConfirmTransaction(connection, tx, [ userKP ])

  return {
    mint:          mint.toBase58(),
    account:       ata.address.toBase58(),
    imageUrl,
    website,
    poolSignature,
  }
}
