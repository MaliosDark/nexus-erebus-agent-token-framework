// twitter-client.js
import { Scraper } from 'agent-twitter-client';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

export class TwitterClient {
  constructor () {
    const opts = {};
    if (process.env.TWITTER_PROXY_URL)
      opts.proxy = process.env.TWITTER_PROXY_URL;

    this.scraper = new Scraper(opts);
    this.cookiePath = process.env.TWITTER_COOKIES_PATH || './cookies.json';
  }

  async init () {
    // 1. Intenta restaurar cookies
    if (this.cookiePath && existsSync(this.cookiePath)) {
      try {
        const cookies = JSON.parse(readFileSync(this.cookiePath, 'utf8'));

        if (!Array.isArray(cookies)) throw new Error('Invalid cookie format');

        await this.scraper.setCookies(cookies); // 👈 sin usar Cookie.fromJSON
        if (await this.scraper.isLoggedIn()) {
          console.log('[TW] session via cookies ✅');
          return;
        }
      } catch (e) {
        console.warn('[TW] cookie restore failed:', e.message);
      }
    }

    // 2. Login con credenciales
    await this.scraper.login(
      process.env.TWITTER_USERNAME,
      process.env.TWITTER_PASSWORD,
      process.env.TWITTER_EMAIL,
      process.env.TWITTER_API_KEY,
      process.env.TWITTER_API_SECRET_KEY,
      process.env.TWITTER_ACCESS_TOKEN,
      process.env.TWITTER_ACCESS_TOKEN_SECRET,
    );
    console.log('[TW] logged in via credentials ✅');

    // 3. Guardar cookies frescos
    if (this.cookiePath) {
      const fresh = await this.scraper.getCookies();
      writeFileSync(this.cookiePath, JSON.stringify(fresh, null, 2));
      console.log('[TW] cookies saved →', this.cookiePath);
    }
  }

  async sendText(text) {
    await this.scraper.sendTweet(text);
  }

  async sendMedia(text, files) {
    const data = files.map(p => {
      const ext = path.extname(p).toLowerCase();
      const mime = ext === '.mp4' ? 'video/mp4'
                : ext === '.gif' ? 'image/gif'
                : 'image/jpeg';
      return { data: fs.readFileSync(p), mediaType: mime };
    });
    await this.scraper.sendTweet(text, undefined, data);
  }

  async sendDm(userId, text) {
    if (this.scraper.sendDM) await this.scraper.sendDM(userId, text);
  }
}
