// telegram-client.js  — inline menu + trade panel + self-mention-strip with chatId persistence
// ---------------------------------------------------------------
import { Telegraf, Markup } from 'telegraf';
import 'dotenv/config';

const TOK      = process.env.TELEGRAM_BOT_TOKEN;
const AGENT    = process.env.AGENT_NAME;
const GREET    = process.env.AGENT_GREETING.replace('%AGENT%', AGENT);
const IMG_URL  = process.env.AGENT_GREETING_IMG;
const MENU_T   = process.env.AGENT_MENU_TITLE.replace('%AGENT%', AGENT);
const BTN_TXT  = process.env.AGENT_MENU_BUTTONS.split(',');   // top-level labels

// helper → callback_data: "<ID>:<handle>"
const cbData = (id,h) => `${id}:${h}`;
const row    = (label,id,h) => [ Markup.button.callback(label, cbData(id,h)) ];

export class TelegramClient {
  constructor () {
    this.bot = new Telegraf(TOK, { handlerTimeout: 9_000 });
    this.helpers = {
      walletOf    : ()=>'–',
      balanceOf   : ()=>({sol:'0',tier:'0'}),
      ensureUser  : h=>console.log('⚠️ ensureUser not implemented',h),
      toggleAuto  : h=>({autoTrade:false,risk:'balanced'}),
      setRisk     : (h,lvl)=>({autoTrade:false,risk:lvl}),
      saveChatId  : async (h,id)=>{}    // will be overridden in index.js
    };
  }

  setHelpers(o){
    this.helpers = { ...this.helpers, ...o };
  }

  // ── inline menus ───────────────────────────────────────────
  static mainMenu(h){
    return Markup.inlineKeyboard(
      BTN_TXT.map(lbl => [ Markup.button.callback(lbl, `${lbl}|${h}`) ])
    );
  }
  static tradeMenu(h){
    return Markup.inlineKeyboard([
      row('🟢 Buy 0.10' , 'QB' , h),
      row('🔴 Sell 0.10', 'QS' , h),
      row('⚙️ Auto ON'  , 'AON', h),
      row('⛔ Auto OFF' , 'AOF', h),
      row('Risk Low'   , 'RL' , h),
      row('Risk Med'   , 'RM' , h),
      row('Risk High'  , 'RH' , h),
      row('↩️ Back'     , 'BK' , h)
    ], { columns: 2 });
  }

  // ── init ──────────────────────────────────────────────────
  async init(cb){
    if(typeof cb!=='function')
      console.warn('⚠️ TelegramClient.init(cb) missing callback');
    this.#routes(cb);
    await this.bot.launch();
    console.log('[TG] bot live');
    this.me = (await this.bot.telegram.getMe()).username.toLowerCase();
  }

  // ── routers ───────────────────────────────────────────────
  #routes(cb){
    // /start
    this.bot.start(async ctx=>{
      const h      = ctx.from.username ?? ctx.from.id.toString();
      const chatId = ctx.chat.id.toString();
      this.helpers.ensureUser(h);
      await this.helpers.saveChatId(h, chatId);
      if (IMG_URL) await ctx.replyWithPhoto(IMG_URL,{caption:GREET});
      else         await ctx.reply(GREET);
      await ctx.reply(MENU_T, TelegramClient.mainMenu(h));
    });

    // callback buttons
    this.bot.on('callback_query', async ctx=>{
      const data     = ctx.callbackQuery.data;
      const chatId   = ctx.callbackQuery.message.chat.id.toString();
      let handle, id;

      // parse handle & id
      if (data.includes('|')){
        [, handle] = data.split('|');
        id = null;
      } else {
        [id, handle] = data.split(':');
      }

      this.helpers.ensureUser(handle);
      await this.helpers.saveChatId(handle, chatId);

      // answer callback query, ignore if expired
      try {
        await ctx.answerCbQuery();
      } catch (err) {
        console.warn('⚠️ answerCbQuery failed:', err.response?.description || err.message);
      }

      // helper to send/edit menu
      const top = m => ctx.editMessageText(m, TelegramClient.mainMenu(handle))
                         .catch(()=>ctx.reply(m, TelegramClient.mainMenu(handle)));
      const tradeMenu = () => ctx.editMessageText('Select an action:', TelegramClient.tradeMenu(handle))
                         .catch(()=>ctx.reply('Select an action:', TelegramClient.tradeMenu(handle)));

      // ── TOP LEVEL ───────────────────────────────────────
      if (!id){
        if (data.startsWith('💰')){
          const address = await this.helpers.walletOf(handle);
          return top(`🔑 Deposit address:\n${address}`);
        }
        if (data.startsWith('🔍')){
          const bal = await this.helpers.balanceOf(handle);
          return top(`Wallet SOL: ${bal.sol}\nAgent tokens: ${bal.tier}`);
        }
        if (data.startsWith('📈')) return tradeMenu();
        if (data.startsWith('❓'))
          return top('Commands:\n/start\n/buy <MINT> <SOL>\n/sell <MINT> <SOL>');
        return;
      }

      // ── TRADE PANEL ───────────────────────────────────────
      const reply = m => ctx.editMessageText(m, TelegramClient.tradeMenu(handle))
                         .catch(()=>ctx.reply(m, TelegramClient.tradeMenu(handle)));

      switch(id){
        case 'QB': return cb({button:`BTN::QBUY::So11111111111111111111111111111111111111112::${handle}`});
        case 'QS': return cb({button:`BTN::QSELL::So11111111111111111111111111111111111111112::${handle}`});

        case 'AON': return reply(stateMsg(this.helpers.toggleAuto(handle,true)));
        case 'AOF': return reply(stateMsg(this.helpers.toggleAuto(handle,false)));

        case 'RL': return reply(stateMsg(this.helpers.setRisk(handle,'low')));
        case 'RM': return reply(stateMsg(this.helpers.setRisk(handle,'med')));
        case 'RH': return reply(stateMsg(this.helpers.setRisk(handle,'high')));

        case 'BK': return ctx.editMessageText(MENU_T, TelegramClient.mainMenu(handle))
                               .catch(()=>ctx.reply(MENU_T, TelegramClient.mainMenu(handle)));
      }
    });

    // text / commands (DM + groups)
    this.bot.on('text', async ctx=>{
      const h      = ctx.from.username ?? ctx.from.id.toString();
      const chatId = ctx.chat.id.toString();
      let   txt    = ctx.message.text;

      // ignore noise in groups
      const hasMention = ctx.message.entities?.some(e=>e.type==='mention');
      if (ctx.chat.type!=='private' && !hasMention && !txt.startsWith('/')) return;

      // strip bot's own mention
      if (this.me)
        txt = txt.replace(new RegExp(`@${this.me}`,'ig'), '').trim();

      this.helpers.ensureUser(h);
      await this.helpers.saveChatId(h, chatId);
      cb?.({
        platform : 'telegram',
        handle   : h,
        text     : txt,
        reply    : m => ctx.telegram.sendMessage(chatId, m)
      });
    });
  }
}

// ───────── helpers ─────────
function stateMsg(st){
  return `Auto-trading *${st.autoTrade?'ENABLED ✅':'DISABLED ❌'}*\nRisk profile: *${st.risk}*`;
}
