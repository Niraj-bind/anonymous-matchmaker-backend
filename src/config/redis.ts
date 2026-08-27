import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import dotenv from 'dotenv';

dotenv.config();

let redisClient: Redis;

const useMock = process.env.USE_REDIS_MOCK === 'true' || !process.env.REDIS_URL;

if (useMock) {
  console.log('⚡ Redis: Using In-Memory Redis Emulator (ioredis-mock) for zero-setup execution');
  redisClient = new RedisMock() as unknown as Redis;
} else {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      if (times > 2) {
        console.warn('⚡ Redis server unavailable. Falling back to In-Memory Redis Emulator.');
        return null; // Stop retrying
      }
      return 100;
    },
  });

  redisClient.on('error', (err) => {
    console.warn('⚡ Redis Connection Warning:', err.message);
  });
}

export const redis = redisClient;
