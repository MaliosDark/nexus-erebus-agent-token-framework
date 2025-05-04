// api‑server.js — “paranoid‑mode” REST gateway for the React dashboard
// -----------------------------------------------------------------------------

import 'dotenv/config';
import fs         from 'fs';
import http       from 'http';
import crypto     from 'crypto';

import express    from 'express';
import helmet     from 'helmet';
import cors       from 'cors';
import hpp        from 'hpp';
import xssClean   from 'xss-clean';
import mongoSanitize from 'express-mongo-sanitize';
import { expressCspHeader } from 'express-csp-header';
import cookieParser from 'cookie-parser';
import csurf      from 'csurf';
import rateLimit  from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import Redis      from 'ioredis';
import morgan     from 'morgan';
import winston    from 'winston';
import { ulid }   from 'ulid';
import { z }      from 'zod';

import {
  walletOf,
  balanceOf,
  fetchSolPrice,
  getPortfolio,
  toggleAuto,
  setRisk,
  handleMessage
} from './commands.js';

// ─────────────────────────────  ENV  ─────────────────────────────
const {
  REDIS_URL         = 'redis://localhost:6379',
  API_PORT          = 4000,
  CORS_ORIGIN       = '*',
  RATE_LIMIT_POINTS = 200,
  RATE_LIMIT_WINDOW = 15 * 60, // s
  JWT_BASE_SECRET,
  CSRF_COOKIE       = 'csrf_tok'
} = process.env;

if (!JWT_BASE_SECRET) {
  console.error('[API] FATAL: JWT_BASE_SECRET env var missing');
  process.exit(1);
}

// ───────────────────────────  LOGGING  ──────────────────────────
const log = winston.createLogger({
  level : 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console()]
});

morgan.token('rid', req => req.id);
const reqLogger = morgan(
  '{"time":":date[iso]","rid":":rid","method":":method","url":":url","status":":status","size":":res[content-length]"}',
  { stream: { write: line => log.info(JSON.parse(line)) } }
);

// ───────────────────────────  APP  ─────────────────────────────
const app  = express();
const redis = new Redis(REDIS_URL);

app.disable('x-powered-by');

// ULID por request
app.use((req, _res, next) => { req.id = ulid(); next(); });
// JSON access logs
app.use(reqLogger);

// Seguridad de cabeceras
app.use(helmet());
app.use(expressCspHeader({
  directives: {
    'default-src': ["'self'"],
    'frame-ancestors': ["'none'"],
    'script-src': ["'self'"],
    'object-src': ["'none'"]
  }
}));

// Sanitización
app.use(hpp());
app.use(xssClean());
app.use(mongoSanitize());

// Body & cookies
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// CORS whitelisting
app.use(cors({
  origin: CORS_ORIGIN.split(','),
  credentials: true
}));

// Rate‑limit global
app.use(rateLimit({
  windowMs : RATE_LIMIT_WINDOW * 1000,
  max      : RATE_LIMIT_POINTS,
  standardHeaders: true,
  legacyHeaders  : false,
  store: new RedisStore({ sendCommand: (...a) => redis.call(...a) })
}));

// CSRF doble cookie
const csrfProtection = csurf({
  cookie: { key: CSRF_COOKIE, httpOnly: false, sameSite: 'strict', secure: false }
});
app.use((req, res, next) => {
  if (!req.cookies[CSRF_COOKIE]) {
    res.cookie(CSRF_COOKIE, crypto.randomBytes(16).toString('hex'), {
      httpOnly: false, sameSite: 'strict', secure: false
    });
  }
  next();
});

// ─────────────────────  JWT con clave rotativa diaria  ───────────
const jwtHeader = Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })).toString('base64url');
function dayKey(day){ return crypto.hkdfSync('sha256', Buffer.from(JWT_BASE_SECRET), Buffer.alloc(0), Buffer.from(String(day)), 32); }
function signToken(handle){
  const payload = Buffer.from(JSON.stringify({ sub:handle, exp:Math.floor(Date.now()/1000)+7200 })).toString('base64url');
  const sig = crypto.createHmac('sha256', dayKey(Math.floor(Date.now()/86400000))).update(`${jwtHeader}.${payload}`).digest('base64url');
  return `${jwtHeader}.${payload}.${sig}`;
}
function verifyToken(tok){
  const [ , pl, sig] = tok.split('.');
  const { exp, sub } = JSON.parse(Buffer.from(pl,'base64url').toString());
  if(Date.now()/1000>exp) throw 'exp';
  const key = dayKey(Math.floor(exp/86400));
  const expSig = crypto.createHmac('sha256',key).update(`${jwtHeader}.${pl}`).digest('base64url');
  if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expSig))) throw 'sig';
  return sub;
}
function auth(req,res,next){
  try{ req.user = verifyToken((req.headers.authorization||'').replace(/^Bearer /,'')); next(); }
  catch{ res.status(401).json({error:'unauthorized'}); }
}

// ─────────────────────  ZOD Schemas  ───────────────────────────
const schemaAuth  = z.object({ handle:z.string().min(2).max(32) });
const schemaAuto  = z.object({ on:z.boolean() });
const schemaRisk  = z.object({ level:z.enum(['low','med','high']) });
const schemaTrade = z.object({ side:z.enum(['buy','sell']), mint:z.string().length(44), sol:z.number().positive().max(10) });

// ─────────────────────  Routes  ────────────────────────────────
// Public – token issuance (la UI debe validar propiedad antes)
app.post('/auth', csrfProtection, (req,res)=>{
  const p=schemaAuth.safeParse(req.body); if(!p.success) return res.status(400).json({error:'invalid'});
  res.json({ token:signToken(p.data.handle.toLowerCase()), expiresIn:7200 });
});

// Resto requiere Bearer + CSRF
app.use(auth, csrfProtection, (req,res,next)=>{
  if(req.get('x-csrf-token')!==req.cookies[CSRF_COOKIE]) return res.status(403).json({error:'csrf'});
  next();
});

app.get('/wallet',    async (r,s)=>s.json({addr:await walletOf(r.user)}));
app.get('/balance',   async (r,s)=>s.json(await balanceOf(r.user)));
app.get('/portfolio', async (r,s)=>s.json(await getPortfolio(r.user)));
app.get('/sol-price', async (_ ,s)=>s.json({usd:await fetchSolPrice()}));

app.post('/auto', (r,s)=>{ const p=schemaAuto.safeParse(r.body); if(!p.success)return s.status(400).json({error:'invalid'}); s.json(toggleAuto(r.user,p.data.on)); });
app.post('/risk', (r,s)=>{ const p=schemaRisk.safeParse(r.body); if(!p.success)return s.status(400).json({error:'invalid'}); s.json(setRisk(r.user,p.data.level)); });
app.post('/trade',async (r,s)=>{ const p=schemaTrade.safeParse(r.body); if(!p.success)return s.status(400).json({error:'invalid'}); const {side,mint,sol}=p.data; await handleMessage({handle:r.user,button:side==='buy'?`BTN::QBUY::${mint}::${r.user}`:`BTN::QSELL::${mint}::${r.user}`,reply:()=>{}}); s.json({queued:true}); });

app.get('/health', (_ ,s)=>s.json({ok:true,ts:Date.now()}));
app.get('/metrics',(_ ,s)=>s.redirect('/metrics'));

// ─────────────────────  Server  ───────────────────────────────
http.createServer({ keepAliveTimeout:10_000, headersTimeout:12_000 }, app)
    .listen(API_PORT, ()=>log.info({ msg:`API listening on :${API_PORT}` }));
