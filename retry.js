// retry.js  — utility to retry async fn with back‑off
export async function withRetry(fn, opts = {}) {
    const {
      attempts = 3,
      delay    = 800,   // ms
      factor   = 2
    } = opts;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); }
      catch (e) { lastErr = e; }
      await new Promise(r => setTimeout(r, delay * Math.pow(factor, i)));
    }
    throw lastErr;
  }
  