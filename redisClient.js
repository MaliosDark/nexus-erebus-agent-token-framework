// redisClient.js
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL, {
    // necesary for BullMQ
    maxRetriesPerRequest: null
  });
export default redis;
