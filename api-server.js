import 'dotenv/config';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import hpp from 'hpp';
import xss from 'xss';    
import mongoSanitize from 'express-mongo-sanitize';
import { expressCspHeader } from 'express-csp-header';
import cookieParser from 'cookie-parser';
import csurf from 'csurf';
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import Redis from 'ioredis';
import morgan from 'morgan';
import winston from 'winston';
import { ulid } from 'ulid';
import { z } from 'zod';

import {
  walletOf,
  balanceOf,
  fetchSolPrice,
  getPortfolio,
  toggleAuto,
  setRisk,
  handleMessage
} from './commands.js';

// Environment validation with better error handling
const envSchema = z.object({ 
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  API_PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().url().optional(),
  RATE_LIMIT_POINTS: z.coerce.number().default(200),
  RATE_LIMIT_WINDOW: z.coerce.number().default(900),
  JWT_BASE_SECRET: z.string().min(32).catch(() => crypto.randomBytes(32).toString('hex')),
  CSRF_COOKIE: z.string().default('csrf_tok'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info')
});

let env;
try {
  env = envSchema.parse(process.env);
} catch (err) {
  console.error('Environment validation failed:', err.message);
  process.exit(1);
}

// Configure logging
const log = winston.createLogger({
  level: env.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ 
      filename: 'error.log', 
      level: 'error' 
    })
  ]
});

// Custom morgan token for request ID
morgan.token('rid', (req) => req.id);

// JSON request logger
const reqLogger = morgan(
  '{"time":":date[iso]","rid":":rid","method":":method","url":":url","status":":status","size":":res[content-length]"}',
  { stream: { write: line => log.info(JSON.parse(line)) } }
);

// Initialize Express app and Redis
const app = express();
let redis;

try {
  redis = new Redis(env.REDIS_URL);
  redis.on('error', (err) => {
    log.error({ msg: 'Redis error', error: err.message });
  });
} catch (err) {
  log.error({ msg: 'Redis connection failed', error: err.message });
  process.exit(1);
}

// Configure proxy trust with specific conditions
app.set('trust proxy', (ip) => {
  return ip === '127.0.0.1' || 
         ip === '::1' ||
         ip.startsWith('10.') || 
         ip.startsWith('172.16.') || 
         ip.startsWith('192.168.');
});

// Basic security setup
app.disable('x-powered-by');

// Request ID middleware
app.use((req, _res, next) => { 
  req.id = ulid(); 
  next(); 
});

// Logging middleware
app.use(reqLogger);

// Security headers with updated CSP for development
app.use(helmet());
app.use(expressCspHeader({
  directives: {
    'default-src': ["'self'"],
    'frame-ancestors': ["'none'"],
    'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'"]
  }
}));

// Sanitization stack
app.use(hpp());
app.use((req, _res, next) => {
  if (req.body) mongoSanitize.sanitize(req.body);
  if (req.params) mongoSanitize.sanitize(req.params);
  next();
});

// XSS protection
app.use((req, _res, next) => {
  const scrub = obj => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string') obj[k] = xss(v);
      else if (typeof v === 'object') scrub(v);
    }
  };
  scrub(req.body);
  scrub(req.params);
  next();
});

// Body parser and cookies
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Updated CORS configuration
app.use(cors({
  origin: env.CORS_ORIGIN || true,
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
  credentials: true,
  allowedHeaders: [
    'Content-Type', 
    'Authorization',
    'X-CSRF-Token',
    'Accept'
  ],
  maxAge: 86400,
  optionsSuccessStatus: 200
}));

// Rate limiting
app.use(rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW * 1000,
  max: env.RATE_LIMIT_POINTS,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ 
    sendCommand: (...args) => redis.call(...args),
    prefix: 'rl:',
    keyPrefix: (req) => {
      const ip = req.ip;
      return `${ip}:`;
    }
  })
}));

// CSRF protection
const csrfProtection = csurf({
  cookie: { 
    key: env.CSRF_COOKIE,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
});

app.use((req, res, next) => {
  if (!req.cookies[env.CSRF_COOKIE]) {
    res.cookie(env.CSRF_COOKIE, crypto.randomBytes(32).toString('hex'), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    });
  }
  next();
});

// JWT helpers with improved error handling
const jwtHeader = Buffer.from(
  JSON.stringify({ alg: 'HS256', typ: 'JWT' })
).toString('base64url');

function dayKey(day) {
  try {
    return crypto.hkdfSync(
      'sha256',
      Buffer.from(env.JWT_BASE_SECRET),
      Buffer.alloc(0),
      Buffer.from(String(day)),
      32
    );
  } catch (err) {
    log.error({ msg: 'JWT key generation failed', error: err.message });
    throw new Error('token_error');
  }
}

function signToken(handle) {
  try {
    const payload = Buffer.from(
      JSON.stringify({
        sub: handle,
        exp: Math.floor(Date.now() / 1000) + 7200,
        iat: Math.floor(Date.now() / 1000)
      })
    ).toString('base64url');

    const sig = crypto
      .createHmac('sha256', dayKey(Math.floor(Date.now() / 86400000)))
      .update(`${jwtHeader}.${payload}`)
      .digest('base64url');

    return `${jwtHeader}.${payload}.${sig}`;
  } catch (err) {
    log.error({ msg: 'Token signing failed', error: err.message });
    throw new Error('token_error');
  }
}

function verifyToken(tok) {
  try {
    const [, pl, sig] = tok.split('.');
    if (!pl || !sig) throw new Error('invalid_token_format');
    
    const { exp, sub } = JSON.parse(Buffer.from(pl, 'base64url').toString());
    if (!exp || !sub) throw new Error('invalid_token_payload');

    if (Date.now() / 1000 > exp) throw new Error('token_expired');

    const key = dayKey(Math.floor(exp / 86400));
    const expSig = crypto
      .createHmac('sha256', key)
      .update(`${jwtHeader}.${pl}`)
      .digest('base64url');

    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expSig)))
      throw new Error('invalid_signature');

    return sub;
  } catch (err) {
    log.error({ msg: 'Token verification failed', error: err.message });
    throw new Error('token_error');
  }
}

// Auth middleware with improved error handling
function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!token) {
      return res.status(401).json({ 
        error: 'unauthorized',
        details: 'No token provided'
      });
    }
    req.user = verifyToken(token);
    next();
  } catch (err) {
    log.warn({ msg: 'Auth failed', error: err.message, rid: req.id });
    res.status(401).json({ 
      error: 'unauthorized',
      details: err.message === 'token_expired' ? 'Token expired' : 'Invalid token'
    });
  }
}

// Request validation schemas
const schemaAuth = z.object({ 
  handle: z.string().min(2).max(32).regex(/^@[a-zA-Z0-9_]+$/),
  method: z.enum(['telegram', 'twitter'])
});

const schemaAuto = z.object({ on: z.boolean() });
const schemaRisk = z.object({ level: z.enum(['low', 'med', 'high']) });
const schemaTrade = z.object({ 
  side: z.enum(['buy', 'sell']),
  mint: z.string().length(44).regex(/^[A-Za-z0-9]+$/),
  sol: z.number().positive().max(10)
});

// Routes with improved error handling
app.post('/auth', csrfProtection, async (req, res) => {
  try {
    log.debug({
      msg: 'Auth request received',
      rid: req.id,
      body: req.body
    });

    const p = schemaAuth.safeParse(req.body);
    if (!p.success) {
      log.warn({ 
        msg: 'Invalid auth data', 
        rid: req.id,
        errors: p.error.errors,
        body: req.body 
      });
      return res.status(400).json({ 
        error: 'invalid',
        details: p.error.errors
      });
    }

    const { handle, method } = p.data;
    const requestOrigin = req.get('origin') || '*';
    log.info({ 
      msg: 'Auth attempt',
      handle,
      method,
      origin: requestOrigin,
      rid: req.id,
      ip: req.ip,
      userAgent: req.get('user-agent')
    });

    let token;
    try {
      token = signToken(handle.toLowerCase());
      log.debug({
        msg: 'Token generated',
        rid: req.id,
        handle: handle.toLowerCase()
      });
    } catch (tokenErr) {
      log.error({
        msg: 'Token generation failed',
        rid: req.id,
        error: tokenErr.message,
        stack: tokenErr.stack
      });
      return res.status(500).json({ 
        error: 'token_error',
        details: 'Failed to generate authentication token'
      });
    }

    res.json({ 
      token,
      expiresIn: 7200,
      method
    });

    log.info({
      msg: 'Auth success',
      rid: req.id,
      handle,
      method
    });
  } catch (err) {
    log.error({ 
      msg: 'Auth error', 
      error: err.message, 
      stack: err.stack,
      rid: req.id,
      body: req.body,
      headers: {
        csrf: req.get('x-csrf-token'),
        origin: req.get('origin'),
        referer: req.get('referer')
      }
    });
    res.status(500).json({ 
      error: 'server_error',
      details: 'Internal server error during authentication'
    });
  }
});

// Protected routes
app.use(auth, csrfProtection, (req, res, next) => {
  const token = req.get('x-csrf-token');
  const storedToken = req.cookies[env.CSRF_COOKIE] || '';

  if (!token || !storedToken || token !== storedToken) {
    log.warn({ 
      msg: 'CSRF mismatch', 
      rid: req.id,
      token: !!token,
      storedToken: !!storedToken
    });
    return res.status(403).json({ error: 'csrf' });
  }
  next();
});

// API endpoints
app.get('/wallet', async (req, res) => {
  try {
    res.json({ addr: await walletOf(req.user) });
  } catch (err) {
    log.error({ msg: 'Wallet error', error: err.message, rid: req.id });
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/balance', async (req, res) => {
  try {
    res.json(await balanceOf(req.user));
  } catch (err) {
    log.error({ msg: 'Balance error', error: err.message, rid: req.id });
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/portfolio', async (req, res) => {
  try {
    res.json(await getPortfolio(req.user));
  } catch (err) {
    log.error({ msg: 'Portfolio error', error: err.message, rid: req.id });
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/sol-price', async (_req, res) => {
  try {
    res.json({ price: await fetchSolPrice() });
  } catch (err) {
    log.error({ msg: 'Price error', error: err.message });
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/auto', (req, res) => {
  try {
    const p = schemaAuto.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid' });
    res.json(toggleAuto(req.user, p.data.on));
  } catch (err) {
    log.error({ msg: 'Auto trading error', error: err.message, rid: req.id });
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/risk', (req, res) => {
  try {
    const p = schemaRisk.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'invalid' });
    res.json(setRisk(req.user, p.data.level));
  } catch (err) {
    log.error({ msg: 'Risk error', error: err.message, rid: req.id });
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/trade', async (req, res) => {
  try {
    const p = schemaTrade.safeParse(req.body);
    if (!p.success) {
      log.warn({
        msg: 'Invalid trade data',
        rid: req.id,
        errors: p.error.errors
      });
      return res.status(400).json({ error: 'invalid' });
    }
    
    const { side, mint, sol } = p.data;
    await handleMessage({
      handle: req.user,
      button: side === 'buy' 
        ? `BTN::QBUY::${mint}::${req.user}`
        : `BTN::QSELL::${mint}::${req.user}`,
      reply: () => {}
    });
    
    res.json({ queued: true });
  } catch (err) {
    log.error({ msg: 'Trade error', error: err.message, rid: req.id });
    res.status(500).json({ error: 'server_error' });
  }
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ 
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

// Error handler
app.use((err, req, res, next) => {
  log.error({ 
    msg: 'Unhandled error',
    error: err.message,
    stack: err.stack,
    rid: req.id
  });
  res.status(500).json({ 
    error: 'server_error',
    details: 'An unexpected error occurred'
  });
});

// Start server
const server = http.createServer({ 
  keepAliveTimeout: 10000,
  headersTimeout: 12000 
}, app);

server.listen(env.API_PORT, () => {
  log.info({ msg: `API listening on :${env.API_PORT}` });
});