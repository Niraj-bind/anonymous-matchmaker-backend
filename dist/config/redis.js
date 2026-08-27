"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.redis = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
const ioredis_mock_1 = __importDefault(require("ioredis-mock"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
let redisClient;
const useMock = process.env.USE_REDIS_MOCK === 'true' || !process.env.REDIS_URL;
if (useMock) {
    console.log('⚡ Redis: Using In-Memory Redis Emulator (ioredis-mock) for zero-setup execution');
    redisClient = new ioredis_mock_1.default();
}
else {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisClient = new ioredis_1.default(redisUrl, {
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
exports.redis = redisClient;
