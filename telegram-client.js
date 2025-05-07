// telegram-client.js — inline menu + trade panel + self-mention-strip + launch flow
// ------------------------------------------------------------------

import { Telegraf, Markup } from 'telegraf';
import 'dotenv/config';

const TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const AGENT_NAME   = process.env.AGENT_NAME;
const GREETING     = process.env.AGENT_GREETING.replace('%AGENT%', AGENT_NAME);
const GREETING_IMG = process.env.AGENT_GREETING_IMG;
const MENU_TITLE   = process.env.AGENT_MENU_TITLE.replace('%AGENT%', AGENT_NAME);

// Helper to form callback_data: "<ACTION_ID>:<userHandle>"
const cbData = (actionId, handle) => `${actionId}:${handle}`;

// Shorthand to create a single button
const btn = (label, actionId, handle) =>
  Markup.button.callback(label, cbData(actionId, handle));

export class TelegramClient {
  constructor() {
    this.bot = new Telegraf(TOKEN, { handlerTimeout: 9_000 });
    this.me  = null;

    // Default stubs, to be overridden via setHelpers()
    this.helpers = {
      walletOf:             async () => '–',
      balanceOf:            async () => ({ sol: '0.000', tier: '0' }),
      fetchSolPrice:        async () => null,
      getPortfolio:         async () => ({ sol: 0, solUsd: '0.00', tokens: [], totalUsd: '0.00' }),
      getHistory:           async () => [],
      ensureUser:           handle => console.warn('⚠️ ensureUser not implemented', handle),
      saveChatId:           async () => {},
      toggleAuto:           () => ({ autoTrade: false, risk: 'balanced' }),
      setRisk:              () => ({ autoTrade: false, risk: 'balanced' }),
      generateLaunchConfig: async () => { throw new Error('generateLaunchConfig not set'); },
      launchToken:          async () => { throw new Error('launchToken not set'); },
    };

    // Track users who chose Manual Launch mode
    this.awaitingManual = new Set();
    // Store last AI‐generated config per user
    this.lastConfigs = {};
  }

  setHelpers(helpersObj) {
    this.helpers = { ...this.helpers, ...helpersObj };
  }

  // ── Top‐level Main Menu ──────────────────────────────────────────
  static mainMenu = handle =>
    Markup.inlineKeyboard([
      [ btn('🔍 Balance',    'BAL',    handle), btn('💲 Price',     'PRICE',  handle), btn('📊 Portfolio','PORT', handle) ],
      [ btn('📈 Trade',      'TRADE',  handle), btn('📘 History',   'HIST',   handle), btn('💰 Deposit',  'DEP',   handle) ],
      [ btn('⚙️ Auto ON',   'AON',    handle), btn('⛔ Auto OFF',  'AOF',    handle), btn('🚀 Launch',   'LAUNCH',handle) ],
      [ btn('❓ Help',       'HELP',   handle) ]
    ], { columns: 3 });

  // ── Trade Submenu ───────────────────────────────────────────────
  static tradeMenu = handle =>
    Markup.inlineKeyboard([
      btn('🟢 Buy 0.10',  'QB', handle),
      btn('🔴 Sell 0.10', 'QS', handle),
      btn('↩️ Back',      'BK', handle),
    ], { columns: 3 });

  // ── Launch Submenu ──────────────────────────────────────────────
  static launchMenu = handle =>
    Markup.inlineKeyboard([
      btn('🤖 AI Launch',     'AICFG', handle),
      btn('🖋 Manual Launch','MANUAL',handle),
      btn('↩️ Back',           'BK',    handle),
    ], { columns: 2 });

  // ── Initialize and bind all routes ─────────────────────────────
  async init(callback) {
    if (typeof callback !== 'function') {
      console.warn('⚠️ TelegramClient.init(callback) missing callback');
    }
    this._bindRoutes(callback);
    await this.bot.launch();
    console.log('[TG] bot live');
    this.me = (await this.bot.telegram.getMe()).username.toLowerCase();
  }

  _bindRoutes(callback) {
    // /start command
    this.bot.start(async ctx => {
      const handle = ctx.from.username ?? String(ctx.from.id);
      const name   = ctx.from.first_name || handle;
      const chatId = String(ctx.chat.id);

      this.helpers.ensureUser(handle);
      await this.helpers.saveChatId(handle, chatId);

      const caption = `*${GREETING}*\n_Hello, ${name}!_`;
      if (GREETING_IMG) {
        await ctx.replyWithPhoto(GREETING_IMG, { caption, parse_mode:'Markdown' });
      } else {
        await ctx.reply(caption, { parse_mode:'Markdown' });
      }

      await ctx.reply(
        MENU_TITLE,
        { parse_mode:'Markdown', ...TelegramClient.mainMenu(handle) }
      );
    });

    // All button callbacks
    this.bot.on('callback_query', async ctx => {
      const data      = ctx.callbackQuery.data;
      const [ actionId, handle ] = data.split(':');
      const msgId     = ctx.callbackQuery.message.message_id;
      const chatId    = String(ctx.callbackQuery.message.chat.id);
      const name      = ctx.from.first_name || handle;
      const now       = new Date().toLocaleTimeString();

      this.helpers.ensureUser(handle);
      await this.helpers.saveChatId(handle, chatId);

      // Acknowledge the button press
      try { await ctx.answerCbQuery(); } catch {}

      // Helper to edit existing message, fallback to new reply
      const editOrReply = async (text, menu = TelegramClient.mainMenu(handle)) => {
        const opts = { parse_mode:'Markdown', ...menu };
        try {
          await ctx.telegram.editMessageText(chatId, msgId, undefined, text, opts);
        } catch {
          await ctx.reply(text, opts);
        }
      };

      switch (actionId) {
        // ── BALANCE ───────────────────────────────────────────────
        case 'BAL': {
          const b = await this.helpers.balanceOf(handle);
          return editOrReply(`*${name}, your balance (as of ${now}):*\n• SOL: \`${b.sol}\`\n• Agent tokens: \`${b.tier}\``);
        }
        // ── PRICE ─────────────────────────────────────────────────
        case 'PRICE': {
          const p = await this.helpers.fetchSolPrice();
          const msg = p != null
            ? `*${name}, SOL price (as of ${now}):* \`$${p.toFixed(2)}\` USD`
            : '❌ Could not fetch SOL price right now.';
          return editOrReply(msg);
        }
        // ── PORTFOLIO ─────────────────────────────────────────────
        case 'PORT': {
          const p = await this.helpers.getPortfolio(handle);
          let txt = `*${name}, your portfolio (as of ${now}):*\n• SOL: \`${p.sol.toFixed(3)}\` (~\`$${p.solUsd}\`)\n`;
          for (const tkn of p.tokens) {
            txt += `• \`${tkn.mint.slice(0,6)}…\`: \`${tkn.amount}\` @ \`$${tkn.price}\` = \`$${tkn.usdValue}\`\n`;
          }
          txt += `*Total:* \`$${p.totalUsd}\``;
          return editOrReply(txt);
        }
        // ── TRADE MENU ────────────────────────────────────────────
        case 'TRADE':
          return editOrReply(`*${name}, choose trade action:*`, TelegramClient.tradeMenu(handle));

        // ── HISTORY ───────────────────────────────────────────────
        case 'HIST': {
          const hist = await this.helpers.getHistory(handle);
          const list = hist.length
            ? hist.map((l,i)=>`${i+1}. ${l}`).join('\n')
            : '_No history yet._';
          return editOrReply(`*${name}, conversation history:*\n${list}`);
        }
        // ── DEPOSIT ADDRESS ───────────────────────────────────────
        case 'DEP': {
          const addr = await this.helpers.walletOf(handle);
          return editOrReply(`🔑 *${name}, your deposit address:*\n\`${addr}\``);
        }
        // ── AUTO-TRADER ON ────────────────────────────────────────
        case 'AON': {
          const st = this.helpers.toggleAuto(handle, true);
          return editOrReply(`*${name}, Auto–Trading ENABLED ✅*\nRisk profile: *${st.risk}*\n_(updated ${now})_`);
        }
        // ── AUTO-TRADER OFF ───────────────────────────────────────
        case 'AOF': {
          const st = this.helpers.toggleAuto(handle, false);
          return editOrReply(`*${name}, Auto–Trading DISABLED ❌*\nRisk profile: *${st.risk}*\n_(updated ${now})_`);
        }
        // ── HELP ─────────────────────────────────────────────────
        case 'HELP': {
          const helpText =
            `*${name}, you can also type these commands:*\n` +
            "`/buy <MINT> <SOL>` — place a buy order\n" +
            "`/sell <MINT> <SOL>` — place a sell order\n" +
            "`deposit`, `balance`, `price`, `portfolio`\n\n" +
            "`auto on|off`, `risk low|med|high`";
          return editOrReply(helpText);
        }
        // ── BUY 0.10 SOL ─────────────────────────────────────────
        case 'QB': {
          await editOrReply(`*${name}, buy order sent (0.10 SOL)*\n_(updated ${now})_`, TelegramClient.tradeMenu(handle));
          return callback({ button: `BTN::QBUY::So11111111111111111111111111111111111111112::${handle}` });
        }
        // ── SELL 0.10 SOL ────────────────────────────────────────
        case 'QS': {
          await editOrReply(`*${name}, sell order sent (0.10 SOL)*\n_(updated ${now})_`, TelegramClient.tradeMenu(handle));
          return callback({ button: `BTN::QSELL::So11111111111111111111111111111111111111112::${handle}` });
        }
        // ── BACK TO MAIN ─────────────────────────────────────────
        case 'BK':
          return editOrReply(MENU_TITLE, TelegramClient.mainMenu(handle));

        // ── LAUNCH MENU ──────────────────────────────────────────
        case 'LAUNCH':
          return editOrReply(`*${name}, choose launch method:*`, TelegramClient.launchMenu(handle));

        // ── AI-GENERATE CONFIG ───────────────────────────────────
        case 'AICFG': {
          await editOrReply('🧠 Generating launch configuration via AI…', TelegramClient.launchMenu(handle));
          try {
            // call user‐provided helper
            const cfg = await this.helpers.generateLaunchConfig(handle);
            this.lastConfigs[handle] = cfg;

            const json = JSON.stringify(cfg, null, 2);
            const preview = `*Config generated:*\n\`\`\`json\n${json}\n\`\`\``;
            const confirmMenu = Markup.inlineKeyboard([
              btn('✅ Confirm & Launch', 'LAUNCH_CONF', handle),
              btn('↩️ Back',             'LAUNCH',      handle),
            ], { columns: 2 });

            return ctx.reply(preview, { parse_mode:'Markdown', ...confirmMenu });
          } catch (err) {
            return ctx.reply(`❌ Failed to generate config:\n${err.message}`, { parse_mode:'Markdown' });
          }
        }
        // ── CONFIRM & LAUNCH ────────────────────────────────────
        case 'LAUNCH_CONF': {
          const cfg = this.lastConfigs[handle];
          if (!cfg) {
            return editOrReply('❌ No configuration found. Please regenerate or use Manual Launch.', TelegramClient.launchMenu(handle));
          }
          await editOrReply('🚀 Launching token…', TelegramClient.launchMenu(handle));
          try {
            const res = await this.helpers.launchToken(cfg, handle);
            const msg =
              `✅ *Token Launched!*\n` +
              `• Mint: \`${res.mint}\`\n` +
              `• Pool Sig: \`${res.poolSignature}\`\n` +
              `• Logo: ${res.imageUrl}\n` +
              `• Metadata: ${res.website}`;
            return ctx.reply(msg, { parse_mode:'Markdown' });
          } catch (err) {
            return ctx.reply(`❌ Launch failed:\n${err.message}`, { parse_mode:'Markdown' });
          }
        }
        // ── MANUAL JSON INPUT ───────────────────────────────────
        case 'MANUAL': {
          await editOrReply('*Please send the launch configuration JSON now.*', TelegramClient.launchMenu(handle));
          this.awaitingManual.add(handle);
          return;
        }
      }
    });

    // ── TEXT MESSAGES (commands + manual JSON) ────────────────
    this.bot.on('text', async ctx => {
      const handle = ctx.from.username ?? String(ctx.from.id);
      const name   = ctx.from.first_name || handle;
      const chatId = String(ctx.chat.id);
      let   text   = ctx.message.text;

      // If expecting manual JSON from this user…
      if (this.awaitingManual.has(handle)) {
        this.awaitingManual.delete(handle);
        let cfg;
        try {
          cfg = JSON.parse(text);
        } catch (e) {
          await ctx.reply('❌ Invalid JSON. Please try /launch again.', { parse_mode:'Markdown' });
          return;
        }
        await ctx.reply('🚀 Launching token with your JSON…', { parse_mode:'Markdown' });
        try {
          const res = await this.helpers.launchToken(cfg, handle);
          const msg =
            `✅ *Token Launched!*\n` +
            `• Mint: \`${res.mint}\`\n` +
            `• Pool Sig: \`${res.poolSignature}\`\n` +
            `• Logo: ${res.imageUrl}\n` +
            `• Metadata: ${res.website}`;
          return ctx.reply(msg, { parse_mode:'Markdown' });
        } catch (err) {
          return ctx.reply(`❌ Launch failed:\n${err.message}`, { parse_mode:'Markdown' });
        }
      }

      // Otherwise, ignore group chatter (unless bot is mentioned) and slash commands
      const hasMention = ctx.message.entities?.some(e => e.type === 'mention');
      if (ctx.chat.type !== 'private' && !hasMention && !text.startsWith('/')) return;

      // Strip any @mention of the bot itself
      if (this.me) {
        text = text.replace(new RegExp(`@${this.me}`, 'ig'), '').trim();
      }

      this.helpers.ensureUser(handle);
      await this.helpers.saveChatId(handle, chatId);

      // Hand off to your top‐level command handler
      callback({
        platform: 'telegram',
        handle,
        text,
        reply: msg => ctx.telegram.sendMessage(chatId, msg, { parse_mode:'HTML' })
      });
    });
  }
}
