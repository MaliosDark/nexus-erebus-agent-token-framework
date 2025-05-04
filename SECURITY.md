
# 🔐 Security Policy – Nexus Erebus Agent Framework

The Nexus Erebus agent framework implements a hardened, layered security model. Despite being open-source, all critical attack surfaces are minimized or isolated. The architecture emphasizes zero trust, least privilege, and auditability.

---

## 🧱 Layered Defense Architecture

Each request is processed through a comprehensive pipeline of input validation, CSRF protection, cryptographic authentication, and strict middleware control before reaching the business logic.

```mermaid
flowchart TD
  %% Client Interface
  UI[React UI]:::client

  %% Auth Flow
  UI -->|POST /auth| Auth[api-server.js /auth]:::api
  Auth -->|JWT issued + CSRF cookie set| UI
  UI -->|Bearer JWT + X-CSRF-Token| Routes[Protected Routes]:::api

  %% Protected Operations
  Routes -->|GET /wallet| Wallet[walletOf(req.user)]:::logic
  Routes -->|POST /trade| Trade[handleMessage()]:::logic

  %% Validation & Control
  Auth -.-> Zod[Zod Schema Validation]:::security
  Auth -.-> Rate[Redis Rate-Limiting]:::security
  Routes -.-> CSRF[CSRF Double Submit Check]:::security
  Routes -.-> JWT[JWT Verification (HKDF)]:::security

  %% Backend Storage & Session
  Wallet & Trade & Rate & CSRF & JWT --> Redis[(Redis)]:::infra

  classDef client fill:#E0F2FE,stroke:#333,color:#000;
  classDef api fill:#DBEAFE,stroke:#333,color:#000;
  classDef logic fill:#EDE9FE,stroke:#333,color:#000;
  classDef security fill:#FCE7F3,stroke:#333,color:#000,font-style:italic;
  classDef infra fill:#FDE68A,stroke:#333,color:#000;
````

---

## 📋 Core Security Features

### API Server (`api-server.js`)

* **HKDF-Based Daily JWT Rotation**
  2-hour expiration with per-day HMAC keys derived via `crypto.hkdfSync`.

* **CSRF Protection (Double Submit Cookie)**
  Implemented using the `csurf` middleware with a same-site cookie and header token match.

* **Input Validation via Zod**
  Strict schema validation prevents malformed or unsafe payloads.

* **Rate-Limiting via RedisStore**
  Per-IP request caps (200 requests per 15 minutes), suitable for distributed deployments.

* **Middleware Hardening**

  * `helmet`: Security-related HTTP headers
  * `xss-clean`: Strips potential XSS vectors
  * `hpp`: Blocks HTTP parameter pollution
  * `express-mongo-sanitize`: Prevents NoSQL injections

* **Per-request ULID Tracing**
  All incoming requests are tagged with a unique cryptographically sortable ID (`ulid`).

* **CORS Isolation**
  Only domains defined in the `CORS_ORIGIN` whitelist are permitted.

* **No Private Key Exposure**
  The API only interfaces with public/derived data. Private keys remain within agent scope.

---

## 🔄 Token Lifecycle

* JWT is signed using a per-day key (`HMAC-SHA256`) derived from `API_JWT_SECRET`
* Tokens expire after 2 hours
* Tokens must be sent as `Authorization: Bearer <token>`
* Protected endpoints also require a valid CSRF header and cookie

```env
API_JWT_SECRET=change_this_to_a_long_random_string
CORS_ORIGIN=https://frontend.yourdomain.app
CSRF_COOKIE=csrf_tok
```

---

## ✅ Authentication Flow

1. Frontend requests `/auth` with a Telegram/Twitter handle
2. Server responds with:

   * JWT signed with daily-rotated key
   * CSRF token set via cookie
3. On subsequent requests:

   * JWT is passed via `Authorization` header
   * CSRF token is passed via `x-csrf-token` header
4. Server verifies JWT signature and expiry, and validates CSRF

Ownership verification (e.g. DM challenge) is expected to be handled at the frontend level **before** requesting the token.

---


## 🔎 Vulnerability Reporting

Please report vulnerabilities responsibly via email:

📧 [malios666@gmail.com](mailto:malios666@gmail.com)

---

## Maintainer

**MaliosDark**
GitHub: [https://github.com/MaliosDark](https://github.com/MaliosDark)

---
