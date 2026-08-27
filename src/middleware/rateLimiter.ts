import { Response, NextFunction } from 'express';
import { redis } from '../config/redis';
import { AuthenticatedRequest } from './authMiddleware';

/**
 * Enforces max 5 failed App ID searches per minute per user.
 */
export async function checkFailedSearchRateLimit(userId: string): Promise<boolean> {
  const key = `failed_searches:${userId}`;
  const countStr = await redis.get(key);
  const count = countStr ? parseInt(countStr, 10) : 0;
  return count < 5;
}

export async function incrementFailedSearchCount(userId: string): Promise<void> {
  const key = `failed_searches:${userId}`;
  const exists = await redis.exists(key);
  if (!exists) {
    await redis.set(key, 1, 'EX', 60);
  } else {
    await redis.incr(key);
  }
}

/**
 * Express middleware for general API rate limiting using Redis
 */
export function createRedisRateLimiter(maxRequests: number, windowSeconds: number) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const identifier = req.user?.userId || req.ip || 'anonymous';
    const key = `rate_limit:${req.baseUrl}${req.path}:${identifier}`;
    
    try {
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.expire(key, windowSeconds);
      }
      
      if (current > maxRequests) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
      }
      next();
    } catch (err) {
      // Fallback if redis has an issue
      next();
    }
  };
}
