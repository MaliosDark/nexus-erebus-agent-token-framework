// telegram-client.js — inline menu + trade panel + self‑mention‑strip
// ------------------------------------------------------------------
import { Telegraf, Markup } from 'telegraf';
import 'dotenv/config';

const TOK     = process.env.TELEGRAM_BOT_TOKEN;
const AGENT   = process.env.AGENT_NAME;
const GREET   = process.env.AGENT_GREETING.replace('%AGENT%', AGENT);
const IMG_URL = process.env.AGENT_GREETING_IMG;
const MENU_T  = process.env.AGENT_MENU_TITLE.replace('%AGENT%', AGENT);

// helper → callback_data: "<ID>:<handle>"
const cbData = (id, h) => `${id}:${h}`;
// one helper to build a button
const btn    = (label, id, h) => Markup.button.callback(label, cbData(id, h));

export class TelegramClient {
  constructor() {
    this.bot = new Telegraf(TOK, { handlerTimeout: 9_000 });
    this.helpers = {
      walletOf:      async () => '–',
      balanceOf:     async () => ({ sol: '0.000', tier: '0' }),
      fetchSolPrice: async () => null,
      getPortfolio:  async () => ({ sol: 0, solUsd: '0.00', tokens: [], totalUsd: '0.00' }),
      getHistory:    async () => [],          // array of strings
      ensureUser:    h => console.log('⚠️ ensureUser not implemented', h),
      toggleAuto:    h => ({ autoTrade: false, risk: 'balanced' }),
      setRisk:       (h, lvl) => ({ autoTrade: false, risk: lvl }),
      saveChatId:    async () => {}           // overridden in index.js
    };
  }

  setHelpers(o) { this.helpers = { ...this.helpers, ...o }; }

  // ── menus ─────────────────────────────────────────────────
  static mainMenu  = h => Markup.inlineKeyboard([
    [ btn('🔍 Balance', 'BAL',   h), btn('💲 Price',    'PRICE', h), btn('📊 Portfolio','PORT', h) ],
    [ btn('📈 Trade',   'TRADE', h), btn('📘 History',  'HIST',  h), btn('💰 Deposit',  'DEP',  h) ],
    [ btn('⚙️ Auto ON', 'AON',   h), btn('⛔ Auto OFF', 'AOF',   h), btn('❓ Help',     'HELP', h) ]
  ], { columns: 3 });

  static tradeMenu = h => Markup.inlineKeyboard([
    btn('🟢 Buy 0.10',  'QB', h),
    btn('🔴 Sell 0.10', 'QS', h),
    btn('↩️ Back',      'BK', h)
  ], { columns: 3 });

  // ── init ─────────────────────────────────────────────────
  async init(cb) {
    if (typeof cb !== 'function') console.warn('⚠️ TelegramClient.init(cb) missing callback');
    this._bindRoutes(cb);
    await this.bot.launch();
    console.log('[TG] bot live');
    this.me = (await this.bot.telegram.getMe()).username.toLowerCase();
  }

  // ── routes ───────────────────────────────────────────────
  _bindRoutes(cb) {
    // /start
    this.bot.start(async ctx => {
      const h      = ctx.from.username ?? ctx.from.id.toString();
      const name   = ctx.from.first_name || h;
      const chatId = ctx.chat.id.toString();
      this.helpers.ensureUser(h);
      await this.helpers.saveChatId(h, chatId);

      const caption = `*${GREET}*\n_Hello, ${name}!_`;
      if (IMG_URL) {
        await ctx.replyWithPhoto(IMG_URL, { caption, parse_mode:'Markdown' });
      } else {
        await ctx.reply(caption, { parse_mode:'Markdown' });
      }
      await ctx.reply(MENU_T, { parse_mode:'Markdown', ...TelegramClient.mainMenu(h) });
    });

    // callbacks
    this.bot.on('callback_query', async ctx => {
      const data   = ctx.callbackQuery.data;
      const msgId  = ctx.callbackQuery.message.message_id;
      const chatId = ctx.callbackQuery.message.chat.id.toString();
      const [ id, handle ] = data.split(':');
      const name = ctx.from.first_name || handle;

      this.helpers.ensureUser(handle);
      await this.helpers.saveChatId(handle, chatId);

      try { await ctx.answerCbQuery(); } catch {}

      const editMenu = async (text, markup = TelegramClient.mainMenu(handle)) => {
        const opts = { parse_mode:'Markdown', ...markup };
        try {
          await ctx.telegram.editMessageText(chatId, msgId, undefined, text, opts);
        } catch {
          await ctx.reply(text, opts);
        }
      };
      const now = new Date().toLocaleTimeString();

      switch (id) {
        case 'BAL': {
          const b = await this.helpers.balanceOf(handle);
          return editMenu(`*${name}, here’s your balance (as of ${now}):*\n• SOL: \`${b.sol}\`\n• Agent tokens: \`${b.tier}\``);
        }
        case 'PRICE': {
          const p = await this.helpers.fetchSolPrice();
          const msg = p != null
            ? `*${name}, SOL price* (as of ${now}): \`$${p.toFixed(2)}\` USD`
            : '❌ Could not fetch SOL price right now.';
          return editMenu(msg);
        }
        case 'PORT': {
          const prt = await this.helpers.getPortfolio(handle);
          let t = `*${name}, your portfolio (as of ${now}):*\n• SOL: \`${prt.sol.toFixed(3)}\` (~\`$${prt.solUsd}\`)\n`;
          for (const tkn of prt.tokens)
            t += `• \`${tkn.mint.slice(0,6)}…\`: \`${tkn.amount}\` @ \`$${tkn.price}\` = \`$${tkn.usdValue}\`\n`;
          t += `*Total:* \`$${prt.totalUsd}\``;
          return editMenu(t);
        }
        case 'TRADE':
          return editMenu(`*${name}, choose trade action:*`, TelegramClient.tradeMenu(handle));

        case 'HIST': {
          const hst = await this.helpers.getHistory(handle);
          const list = hst.length ? hst.map((e,i)=>`${i+1}. ${e}`).join('\n') : '_No history yet._';
          return editMenu(`*${name}, conversation history:*\n${list}`);
        }
        case 'DEP': {
          const addr = await this.helpers.walletOf(handle);
          return editMenu(`🔑 *${name}, your deposit address:*\n\`${addr}\``);
        }
        case 'AON': {
          const st = this.helpers.toggleAuto(handle, true);
          return editMenu(`*${name}, Auto–Trading ENABLED ✅*\nRisk profile: *${st.risk}*\n_(updated ${now})_`);
        }
        case 'AOF': {
          const st = this.helpers.toggleAuto(handle, false);
          return editMenu(`*${name}, Auto–Trading DISABLED ❌*\nRisk profile: *${st.risk}*\n_(updated ${now})_`);
        }
        case 'HELP': {
          const hTxt =
            `*${name}, here are some commands you can type:*\n` +
            "`/buy <MINT> <SOL>` — place a buy order\n" +
            "`/sell <MINT> <SOL>` — place a sell order\n" +
            "`deposit`, `balance`, `price`, `portfolio`\n\n" +
            "`auto on|off`, `risk low|med|high`";
          return editMenu(hTxt);
        }

        // ─ trade panel ───────────────────────────
        case 'QB': {
          await editMenu(`*${name}, buy order sent (0.10 SOL)*\n_(updated ${now})_`, TelegramClient.tradeMenu(handle));
          return cb({ button:`BTN::QBUY::So11111111111111111111111111111111111111112::${handle}` });
        }
        case 'QS': {
          await editMenu(`*${name}, sell order sent (0.10 SOL)*\n_(updated ${now})_`, TelegramClient.tradeMenu(handle));
          return cb({ button:`BTN::QSELL::So11111111111111111111111111111111111111112::${handle}` });
        }
        case 'BK':
          return editMenu(MENU_T, TelegramClient.mainMenu(handle));
      }
    });

    // DM / mentions
    this.bot.on('text', async ctx => {
      const h      = ctx.from.username ?? ctx.from.id.toString();
      const chatId = ctx.chat.id.toString();
      let   txt    = ctx.message.text;

      const hasMention = ctx.message.entities?.some(e=>e.type==='mention');
      if (ctx.chat.type!=='private' && !hasMention && !txt.startsWith('/')) return;

      if (this.me) txt = txt.replace(new RegExp(`@${this.me}`, 'ig'), '').trim();
      this.helpers.ensureUser(h);
      await this.helpers.saveChatId(h, chatId);

      cb({
        platform: 'telegram',
        handle:   h,
        text:     txt,
        reply:    m => ctx.telegram.sendMessage(chatId, m, { parse_mode:'Markdown' })
      });
    });
  }
}
