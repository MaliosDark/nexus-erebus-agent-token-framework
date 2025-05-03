
<p align="center">
  <img src="assets/banner.png" width="650" height="350" alt="Nexus Erebus – Autonomous Agent Token Framework">
</p>

<p align="center">
  <!-- GitHub stats -->
  <a href="https://github.com/MaliosDark/nexus-erebus-agent-token-framework/stargazers">
    <img alt="Stars"
         src="https://img.shields.io/github/stars/MaliosDark/nexus-erebus-agent-token-framework?style=for-the-badge&logo=github" />
  </a>
  <a href="https://github.com/MaliosDark/nexus-erebus-agent-token-framework/network/members">
    <img alt="Forks"
         src="https://img.shields.io/github/forks/MaliosDark/nexus-erebus-agent-token-framework?style=for-the-badge&logo=github" />
  </a>
  <a href="https://github.com/MaliosDark/nexus-erebus-agent-token-framework/issues">
    <img alt="Open Issues"
         src="https://img.shields.io/github/issues/MaliosDark/nexus-erebus-agent-token-framework?style=for-the-badge&color=informational" />
  </a>
  <a href="https://github.com/MaliosDark/nexus-erebus-agent-token-framework/blob/main/LICENSE">
    <img alt="License"
         src="https://img.shields.io/github/license/MaliosDark/nexus-erebus-agent-token-framework?style=for-the-badge&color=success" />
  </a>
  <a href="https://github.com/MaliosDark/nexus-erebus-agent-token-framework/commits/main">
    <img alt="Last Commit"
         src="https://img.shields.io/github/last-commit/MaliosDark/nexus-erebus-agent-token-framework?style=for-the-badge" />
  </a>
  <a href="https://komarev.com/ghpvc/?username=MaliosDark&repo=nexus-erebus-agent-token-framework">
    <img alt="Repo views"
         src="https://komarev.com/ghpvc/?username=MaliosDark&repo=nexus-erebus-agent-token-framework&style=for-the-badge&color=brightgreen" />
  </a>

  <!-- Tech / ecosystem -->
  <br/>
  <img alt="Solana"
       src="https://img.shields.io/badge/Solana-mainnet%20beta-14f195?style=for-the-badge&logo=solana&logoColor=white" />
  <img alt="Telegram bot"
       src="https://img.shields.io/badge/Telegram-bot-blue?style=for-the-badge&logo=telegram" />
  <img alt="Twitter agent"
       src="https://img.shields.io/badge/Twitter-agent-1DA1F2?style=for-the-badge&logo=twitter&logoColor=white" />
  <img alt="Languages count"
       src="https://img.shields.io/github/languages/count/MaliosDark/nexus-erebus-agent-token-framework?style=for-the-badge" />
  <img alt="Top language"
       src="https://img.shields.io/github/languages/top/MaliosDark/nexus-erebus-agent-token-framework?style=for-the-badge" />
</p>


---

# Nexus Erebus 🚀  Autonomous Agent‑Token Framework

*Nexus Erebus* lets you spin up AI‑driven social agents, and beyond—each running real on‑chain strategies, burning $NXR for fuel, and rewarding holders of their micro‑tokens.


## ✨ Features

| Module | Highlights |
|--------|------------|
| **🧠 Agent Core** | Ollama‑driven persona with memory retrieval + goals from `.env`. |
| **🔄 Auto‑Wallet** | One wallet per user; handles SOL → token swaps, fee‑reserve, and NXR burns. |
| **📈 Jupiter v6 Swaps** | Real main‑net trades with retry & slippage guard. |
| **🔥 NXR Burn Loop** | Every action swaps SOL → $NXR → burn + dev‑fee. |
| **🖼 Telegram UI** | Banner greeting, inline menu, DM‑only sensitive data. |
| **🐤 Twitter Bridge** | `@mention` commands + cookie/proxy session reuse. |
| **💾 Persistence** | LowDB user vault + JSON memory per agent. |
| **🛡 Security** | No external wallet read; agent only trusts its own keys. |
| **🧱 Bubble Firewall** | Runtime shield that depletes on errors and RPC failures. |
| **✅ Environment Checker** | Verifies required config & files on boot. |

---

## 🏗 Folder Structure

```text
📦 nexus‑erebus-agent-token-framework
 ├─ index.js          # main runner (reads .env)
 ├─ check-env.js      # 🔐 checks required .env vars + files
 ├─ firewall.js       # 🧱 bubble shield + HP decay
 ├─ twitter-client.js # cookie+proxy login wrapper
 ├─ telegram-client.js# menu, helpers, safe DM
 ├─ utils-solana.js   # Jupiter, SPL, balance listeners
 ├─ db.js             # LowDB user storage
 ├─ memory.js         # simple convo memory
 ├─ retry.js          # exponential back‑off wrapper
 ├─ assets/
 │   └─ banner.png    # 650×350 hero image
 └─ .env              # ✨ edit everything here
```

---

## 🚀 Quick Start

```bash
git clone https://github.com/MaliosDark/nexus-erebus-agent-token-framework
cd nexus-erebus-agent-token-framework
cp .env.example .env       # fill in your agent keys + config
npm install                # install all dependencies
npm start                  # auto-checks .env + starts agent
```

> ✅ `npm start` uses `check-env.js` to verify:
> - `.env` + required fields
> - presence of `index.js`, `package.json`
> - readable config before booting any Solana agent

## 🐤 Twitter Command Cheatsheet  *(v 2.1)*

> Mention the bot in a tweet **or** reply to any of its tweets.  
> The bot only parses messages that include its handle (`@YourBot`).

| Purpose | Syntax (example) | Notes |
|---------|-----------------|-------|
| **Show deposit address** | `@YourBot deposit`<br/>`@YourBot wallet` | Returns the SOL address bound to your Twitter handle. |
| **Show balance** | `@YourBot balance` | SOL & agent‑token holdings. |
| **Buy a token** | `@YourBot buy 8HVy… 0.25` | `buy <MINT> <SOL>` |
| **Sell a token** | `@YourBot sell 8HVy… 0.25` | Reverse swap. |
| **Toggle auto‑trading** | `@YourBot auto on`<br/>`@YourBot auto off` | Per‑user switch. |
| **Set risk profile** | `@YourBot risk low` / `med` / `high` | Influences future auto‑trades. |

⚠️ Make sure you set **`AGENT_TW_HANDLE`** in your `.env` — *without* the
leading “@” — so the framework can strip self‑mentions before parsing.

---

## 📜 Environment Reference

| Variable | Description |
|----------|-------------|
| `AGENT_NAME`            | `Agent1` / `Agent2` / your‑agent |
| `AGENT_MINT`            | SPL mint of the agent token |
| `TIER_THRESHOLDS`       | CSV of bronze,silver,gold levels |
| `RPC`                   | Solana RPC endpoint |
| `NXR_MINT`              | Core $NXR mint |
| `DEV_WALLET_SK`         | JSON array secret‑key (burn fee receiver) |
| `OLLAMA_URL`            | Local Ollama endpoint |
| `OLLAMA_MODEL`          | eg. `llama3.2:3b` |
| `TELEGRAM_BOT_TOKEN`    | BotFather token |
| `TWITTER_USERNAME`      | Twitter login (UI scraping) |
| `TWITTER_PASSWORD`      | Twitter login |
| `TWITTER_PROXY_URL`     | Optional proxy `http://user:pass@ip:port` |
| `TWITTER_COOKIES_PATH`  | Reuses session across boots |
| `AGENT_TW_HANDLE`       | Bot’s Twitter handle **without “@”** |
| `FW_MAX_HP`             | Starting firewall HP (default `20`) |
| `FW_DECAY_ON_ERROR`     | HP lost per logic error (default `2`) |
| `FW_DECAY_ON_RPC_FAIL`  | HP lost on RPC/network errors (default `5`) |
| `FW_AUTO_EXIT`          | Shut down on 0 HP (`true` / `false`) |

---

## 🖼️ Screenshots

| Welcome Banner (DM) | Inline Menu |
|---------------------|-------------|
| <img src="assets/welcome.png" width="400"/> | <img src="assets/inline.png" width="400"/> |

---

## 🛡 Bubble Firewall Protection

Each agent runs inside a **protective runtime firewall**:
- 💥 Tracks every swap failure, RPC error, or exception
- 🔋 Visual HP bar in the console
- 🔐 Auto-shuts down when health reaches 0 to protect your keys
- 🧠 Configurable via `.env`: `FW_MAX_HP`, `FW_DECAY_ON_ERROR`, etc.

---

## 🤝 Contributing

1. **Fork** the repo  
2. `npm i` and run `npm run lint` before PR  

Stars ⭐ and feedback are always welcome!

---

<p align="center">
Made with 🖤 by Malios Dark & the Nexus Erebus core team · Powered by Solana, Ollama & Jupiter
</p>
