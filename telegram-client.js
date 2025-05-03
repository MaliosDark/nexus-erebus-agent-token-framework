// telegram‑client.js  — inline menu + trade panel + self‑mention‑strip
// ---------------------------------------------------------------
import { Telegraf, Markup } from 'telegraf'
import 'dotenv/config'

const TOK      = process.env.TELEGRAM_BOT_TOKEN
const AGENT    = process.env.AGENT_NAME
const GREET    = process.env.AGENT_GREETING.replace('%AGENT%', AGENT)
const IMG_URL  = process.env.AGENT_GREETING_IMG
const MENU_T   = process.env.AGENT_MENU_TITLE.replace('%AGENT%', AGENT)
const BTN_TXT  = process.env.AGENT_MENU_BUTTONS.split(',')   // top‑level labels

// helper → callback_data: "<ID>:<handle>"
const cbData = (id,h) => `${id}:${h}`
const row    = (label,id,h) => [ Markup.button.callback(label, cbData(id,h)) ]

export class TelegramClient {
  constructor () {
    this.bot = new Telegraf(TOK, { handlerTimeout: 9_000 })
    this.helpers = {
      walletOf   : ()=>'–',
      balanceOf  : ()=>({sol:'0',tier:'0'}),
      ensureUser : h=>console.log('⚠️ ensureUser not implemented',h),
      toggleAuto : h=>({autoTrade:false,risk:'balanced'}),
      setRisk    : (h,lvl)=>({autoTrade:false,risk:lvl})
    }
  }
  setHelpers(o){ this.helpers = { ...this.helpers, ...o } }

  // ── inline menus ───────────────────────────────────────────
  static mainMenu(h){
    // original four “Balance / Trade / Deposit / Help” buttons
    return Markup.inlineKeyboard(
      BTN_TXT.map(lbl => [ Markup.button.callback(lbl, `${lbl}|${h}`) ])
    )
  }
  static tradeMenu(h){
    return Markup.inlineKeyboard([
      row('🟢 Buy 0.10' , 'QB' , h),
      row('🔴 Sell 0.10', 'QS' , h),
      row('⚙️ Auto ON'  , 'AON', h),
      row('⛔ Auto OFF' , 'AOF', h),
      row('Risk Low'   , 'RL' , h),
      row('Risk Med'   , 'RM' , h),
      row('Risk High'  , 'RH' , h),
      row('↩️ Back'     , 'BK' , h)
    ], { columns: 2 })
  }

  // ── init ──────────────────────────────────────────────────
  async init(cb){
    if(typeof cb!=='function')
      console.warn('⚠️ TelegramClient.init(cb) missing')
    this.#routes(cb)
    await this.bot.launch()
    console.log('[TG] bot live')

    // save our own @username to strip self‑mentions later
    this.me = (await this.bot.telegram.getMe()).username.toLowerCase()
  }

  // ── routers ───────────────────────────────────────────────
  #routes(cb){
    // /start
    this.bot.start(async ctx=>{
      const h = ctx.from.username ?? ctx.from.id.toString()
      this.helpers.ensureUser(h)
      if (IMG_URL) await ctx.replyWithPhoto(IMG_URL,{caption:GREET})
      else         await ctx.reply(GREET)
      await ctx.reply(MENU_T, TelegramClient.mainMenu(h))
    })

    // buttons
    this.bot.on('callback_query', async ctx=>{
      const data = ctx.callbackQuery.data
      let handle, id

      // form1: "Label|handle"  (main menu)
      if (data.includes('|')){
        [, handle] = data.split('|')
        id = null
      }else{                       // form2: "<ID>:handle"
        [id, handle] = data.split(':')
      }

      this.helpers.ensureUser(handle)
      await ctx.answerCbQuery()

      const top = m => ctx.editMessageText(m, TelegramClient.mainMenu(handle))
                           .catch(()=>ctx.reply(m, TelegramClient.mainMenu(handle)))
      const tradeMenu = () => ctx.editMessageText('Select an action:',
                                TelegramClient.tradeMenu(handle))
                           .catch(()=>ctx.reply('Select an action:',
                                TelegramClient.tradeMenu(handle)))

      // ── TOP LEVEL (original four) ─────────────────────────
      if (!id){
        if (data.startsWith('💰'))
          return top(`🔑 Deposit address:\n${this.helpers.walletOf(handle)}`)
        if (data.startsWith('🔍'))
          return top(formatBal(this.helpers.balanceOf(handle)))
        if (data.startsWith('📈')) return tradeMenu()
        if (data.startsWith('❓'))
          return top('Commands:\n/start\n/buy <MINT> <SOL>\n/sell <MINT> <SOL>')
        return
      }

      // ── TRADE PANEL (short IDs) ───────────────────────────
      const reply = m => ctx.editMessageText(m, TelegramClient.tradeMenu(handle))
                             .catch(()=>ctx.reply(m, TelegramClient.tradeMenu(handle)))

      switch(id){
        case 'QB': return cb({button:`BTN::QBUY::So11111111111111111111111111111111111111112::${handle}`})
        case 'QS': return cb({button:`BTN::QSELL::So11111111111111111111111111111111111111112::${handle}`})

        case 'AON': return reply(stateMsg(this.helpers.toggleAuto(handle,true)))
        case 'AOF': return reply(stateMsg(this.helpers.toggleAuto(handle,false)))

        case 'RL': return reply(stateMsg(this.helpers.setRisk(handle,'low')))
        case 'RM': return reply(stateMsg(this.helpers.setRisk(handle,'med')))
        case 'RH': return reply(stateMsg(this.helpers.setRisk(handle,'high')))

        case 'BK': return ctx.editMessageText(MENU_T, TelegramClient.mainMenu(handle))
                               .catch(()=>ctx.reply(MENU_T, TelegramClient.mainMenu(handle)))
      }
    })

    // text / commands (DM + groups)
    this.bot.on('text', ctx=>{
      const h   = ctx.from.username ?? ctx.from.id.toString()
      let   txt = ctx.message.text
      const chatId = ctx.chat.id

      // ignore noise in groups
      const hasMention = ctx.message.entities?.some(e=>e.type==='mention')
      if (ctx.chat.type!=='private' && !hasMention && !txt.startsWith('/')) return

      // strip *our own* @mention so the agent doesn't echo it
      if (this.me)
        txt = txt.replace(new RegExp(`@${this.me}`,'ig'), '').trim()

      this.helpers.ensureUser(h)
      cb?.({
        platform : 'telegram',
        handle   : h,
        text     : txt,
        reply    : m => ctx.telegram.sendMessage(chatId, m)
      })
    })
  }
}

/* ───────── helpers ───────── */
const stateMsg = st =>
  `Auto‑trading *${st.autoTrade?'ENABLED ✅':'DISABLED ❌'}*\nRisk profile: *${st.risk}*`

const formatBal = b =>
  `Wallet SOL: ${b.sol}\nAgent tokens: ${b.tier}`
