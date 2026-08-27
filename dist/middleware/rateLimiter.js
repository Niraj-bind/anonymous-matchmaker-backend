"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkFailedSearchRateLimit = checkFailedSearchRateLimit;
exports.incrementFailedSearchCount = incrementFailedSearchCount;
exports.createRedisRateLimiter = createRedisRateLimiter;
const redis_1 = require("../config/redis");
/**
 * Enforces max 5 failed App ID searches per minute per user.
 */
async function checkFailedSearchRateLimit(userId) {
    const key = `failed_searches:${userId}`;
    const countStr = await redis_1.redis.get(key);
    const count = countStr ? parseInt(countStr, 10) : 0;
    return count < 5;
}
async function incrementFailedSearchCount(userId) {
    const key = `failed_searches:${userId}`;
    const exists = await redis_1.redis.exists(key);
    if (!exists) {
        await redis_1.redis.set(key, 1, 'EX', 60);
    }
    else {
        await redis_1.redis.incr(key);
    }
}
/**
 * Express middleware for general API rate limiting using Redis
 */
function createRedisRateLimiter(maxRequests, windowSeconds) {
    return async (req, res, next) => {
        const identifier = req.user?.userId || req.ip || 'anonymous';
        const key = `rate_limit:${req.baseUrl}${req.path}:${identifier}`;
        try {
            const current = await redis_1.redis.incr(key);
            if (current === 1) {
                await redis_1.redis.expire(key, windowSeconds);
            }
            if (current > maxRequests) {
                return res.status(429).json({ error: 'Too many requests. Please try again later.' });
            }
            next();
        }
        catch (err) {
            // Fallback if redis has an issue
            next();
        }
    };
}
