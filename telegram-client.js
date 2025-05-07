// telegram-client.js — inline menu + trade panel + self-mention-strip + launch flow
// ------------------------------------------------------------------

import { Telegraf, Markup } from 'telegraf';
import 'dotenv/config';

const TOK            = process.env.TELEGRAM_BOT_TOKEN;
const AGENT          = process.env.AGENT_NAME;
const GREETING       = process.env.AGENT_GREETING.replace('%AGENT%', AGENT);
const GREETING_IMG   = process.env.AGENT_GREETING_IMG;
const MENU_TITLE     = process.env.AGENT_MENU_TITLE.replace('%AGENT%', AGENT);

// helper → callback_data: "<ID>:<handle>"
const cbData = (id, h) => `${id}:${h}`;

// one helper to build a button
const btn = (label, id, h) => Markup.button.callback(label, cbData(id, h));

export class TelegramClient {
  constructor() {
    this.bot = new Telegraf(TOK, { handlerTimeout: 9_000 });
    this.me  = null;

    // default stubs; will be overwritten by index.js
    this.helpers = {
      walletOf:           async () => '–',
      balanceOf:          async () => ({ sol: '0.000', tier: '0' }),
      fetchSolPrice:      async () => null,
      getPortfolio:       async () => ({ sol: 0, solUsd: '0.00', tokens: [], totalUsd: '0.00' }),
      getHistory:         async () => [],
      ensureUser:         h => console.warn('⚠️ ensureUser not implemented', h),
      saveChatId:         async () => {},
      toggleAuto:         () => ({ autoTrade: false, risk: 'balanced' }),
      setRisk:            () => ({ autoTrade: false, risk: 'balanced' }),
      generateLaunchConfig: async () => { throw new Error('generateLaunchConfig not set'); },
      launchToken:          async () => { throw new Error('launchToken not set'); },
    };

    // track manual-JSON mode
    this.awaitingManual = new Set();
    // store last AI config per user
    this.lastConfigs    = {};
  }

  setHelpers(o) {
    this.helpers = { ...this.helpers, ...o };
  }

  // ── top-level main menu ───────────────────────────────────────────
  static mainMenu = h => Markup.inlineKeyboard([
    [ btn('🔍 Balance',    'BAL',    h), btn('💲 Price',     'PRICE',  h), btn('📊 Portfolio','PORT', h) ],
    [ btn('📈 Trade',      'TRADE',  h), btn('📘 History',   'HIST',   h), btn('💰 Deposit', 'DEP',   h) ],
    [ btn('⚙️ Auto ON',   'AON',    h), btn('⛔ Auto OFF',  'AOF',    h), btn('🚀 Launch',  'LAUNCH',h) ],
    [ btn('❓ Help',       'HELP',   h) ]
  ], { columns: 3 });

  // ── trade submenu ─────────────────────────────────────────────────
  static tradeMenu = h => Markup.inlineKeyboard([
    btn('🟢 Buy 0.10',  'QB', h),
    btn('🔴 Sell 0.10', 'QS', h),
    btn('↩️ Back',      'BK', h)
  ], { columns: 3 });

  // ── launch submenu ────────────────────────────────────────────────
  static launchMenu = h => Markup.inlineKeyboard([
    btn('🤖 AI Launch',     'AICFG', h),
    btn('🖋 Manual Launch','MANUAL',h),
    btn('↩️ Back',           'BK',    h)
  ], { columns: 2 });

  // ── init & bind routes ───────────────────────────────────────────
  async init(cb) {
    if (typeof cb !== 'function') {
      console.warn('⚠️ TelegramClient.init(cb) missing callback');
    }
    this._bindRoutes(cb);
    await this.bot.launch();
    console.log('[TG] bot live');
    this.me = (await this.bot.telegram.getMe()).username.toLowerCase();
  }

  // ── internal route-bindings ──────────────────────────────────────
  _bindRoutes(cb) {
    // /start handler
    this.bot.start(async ctx => {
      const handle = ctx.from.username ?? ctx.from.id.toString();
      const name   = ctx.from.first_name || handle;
      const chatId = ctx.chat.id.toString();

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

    // callback_query handler
    this.bot.on('callback_query', async ctx => {
      const data    = ctx.callbackQuery.data;
      const [ id, handle ] = data.split(':');
      const msgId   = ctx.callbackQuery.message.message_id;
      const chatId  = ctx.callbackQuery.message.chat.id.toString();
      const name    = ctx.from.first_name || handle;
      const now     = new Date().toLocaleTimeString();

      this.helpers.ensureUser(handle);
      await this.helpers.saveChatId(handle, chatId);

      // ack
      try { await ctx.answerCbQuery(); } catch {}

      // helper to edit or fallback to new message
      const edit = async (text, menu = TelegramClient.mainMenu(handle)) => {
        const opts = { parse_mode:'Markdown', ...menu };
        try {
          await ctx.telegram.editMessageText(chatId, msgId, undefined, text, opts);
        } catch {
          await ctx.reply(text, opts);
        }
      };

      switch (id) {
        // ── balance, price, portfolio ─────────────────────────
        case 'BAL': {
          const b = await this.helpers.balanceOf(handle);
          return edit(`*${name}, your balance (as of ${now}):*\n• SOL: \`${b.sol}\`\n• Agent tokens: \`${b.tier}\``);
        }
        case 'PRICE': {
          const p = await this.helpers.fetchSolPrice();
          const msg = p != null
            ? `*${name}, SOL price (as of ${now}):* \`$${p.toFixed(2)}\` USD`
            : '❌ Could not fetch SOL price right now.';
          return edit(msg);
        }
        case 'PORT': {
          const p = await this.helpers.getPortfolio(handle);
          let txt = `*${name}, your portfolio (as of ${now}):*\n• SOL: \`${p.sol.toFixed(3)}\` (~\`$${p.solUsd}\`)\n`;
          for (const tkn of p.tokens) {
            txt += `• \`${tkn.mint.slice(0,6)}…\`: \`${tkn.amount}\` @ \`$${tkn.price}\` = \`$${tkn.usdValue}\`\n`;
          }
          txt += `*Total:* \`$${p.totalUsd}\``;
          return edit(txt);
        }

        // ── trade submenu ───────────────────────────────────
        case 'TRADE':
          return edit(`*${name}, choose trade action:*`, TelegramClient.tradeMenu(handle));

        // ── history, deposit ─────────────────────────────────
        case 'HIST': {
          const hst = await this.helpers.getHistory(handle);
          const list = hst.length
            ? hst.map((e,i)=>`${i+1}. ${e}`).join('\n')
            : '_No history yet._';
          return edit(`*${name}, conversation history:*\n${list}`);
        }
        case 'DEP': {
          const addr = await this.helpers.walletOf(handle);
          return edit(`🔑 *${name}, your deposit address:*\n\`${addr}\``);
        }

        // ── auto/trading toggles ─────────────────────────────
        case 'AON': {
          const st = this.helpers.toggleAuto(handle, true);
          return edit(`*${name}, Auto–Trading ENABLED ✅*\nRisk profile: *${st.risk}*\n_(updated ${now})_`);
        }
        case 'AOF': {
          const st = this.helpers.toggleAuto(handle, false);
          return edit(`*${name}, Auto–Trading DISABLED ❌*\nRisk profile: *${st.risk}*\n_(updated ${now})_`);
        }

        // ── help ─────────────────────────────────────────────
        case 'HELP': {
          const helpText =
            `*${name}, commands you can type:*\n` +
            "`/buy <MINT> <SOL>` — place a buy order\n" +
            "`/sell <MINT> <SOL>` — place a sell order\n" +
            "`deposit`, `balance`, `price`, `portfolio`\n\n" +
            "`auto on|off`, `risk low|med|high`";
          return edit(helpText);
        }

        // ── trade details ───────────────────────────────────
        case 'QB': {
          await edit(`*${name}, buy order sent (0.10 SOL)*\n_(updated ${now})_`, TelegramClient.tradeMenu(handle));
          return cb({ button:`BTN::QBUY::So11111111111111111111111111111111111111112::${handle}` });
        }
        case 'QS': {
          await edit(`*${name}, sell order sent (0.10 SOL)*\n_(updated ${now})_`, TelegramClient.tradeMenu(handle));
          return cb({ button:`BTN::QSELL::So11111111111111111111111111111111111111112::${handle}` });
        }
        case 'BK':
          return edit(MENU_TITLE, TelegramClient.mainMenu(handle));

        // ── launch submenu ─────────────────────────────────
        case 'LAUNCH':
          return edit(`*${name}, choose launch method:*`, TelegramClient.launchMenu(handle));

        case 'AICFG': {
          await edit('🧠 Generating launch configuration via AI…', TelegramClient.launchMenu(handle));
          try {
            const cfg = await this.helpers.generateLaunchConfig(handle);
            this.lastConfigs[handle] = cfg;
            const json = JSON.stringify(cfg, null, 2);
            const preview = `*Config generated:*\n\`\`\`json\n${json}\n\`\`\``;
            const confirmMenu = Markup.inlineKeyboard([
              btn('✅ Confirm & Launch', 'LAUNCH_CONF', handle),
              btn('↩️ Back',           'LAUNCH',     handle)
            ], { columns:2 });
            return ctx.reply(preview, { parse_mode:'Markdown', ...confirmMenu });
          } catch (err) {
            return ctx.reply(`❌ Failed to generate config:\n${err.message}`, { parse_mode:'Markdown' });
          }
        }

        case 'LAUNCH_CONF': {
          const cfg = this.lastConfigs[handle];
          if (!cfg) {
            return edit('❌ No configuration found. Please regenerate or use Manual Launch.', TelegramClient.launchMenu(handle));
          }
          await edit('🚀 Launching token…', TelegramClient.launchMenu(handle));
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

        case 'MANUAL': {
          await edit('*Please send the launch configuration JSON now.*', TelegramClient.launchMenu(handle));
          this.awaitingManual.add(handle);
          return;
        }
      }
    });

    // text handler: commands + manual-JSON
    this.bot.on('text', async ctx => {
      const handle = ctx.from.username ?? ctx.from.id.toString();
      const chatId = ctx.chat.id.toString();
      let   text   = ctx.message.text;

      // if user is expected to send manual JSON…
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

      // otherwise, only handle DMs and mentions
      const hasMention = ctx.message.entities?.some(e => e.type === 'mention');
      if (ctx.chat.type !== 'private' && !hasMention && !text.startsWith('/')) return;

      if (this.me) {
        text = text.replace(new RegExp(`@${this.me}`, 'ig'), '').trim();
      }

      this.helpers.ensureUser(handle);
      await this.helpers.saveChatId(handle, chatId);

      cb({
        platform: 'telegram',
        handle,
        text,
        reply: msg => ctx.telegram.sendMessage(chatId, msg, { parse_mode:'HTML' })
      });
    });
  }
}
