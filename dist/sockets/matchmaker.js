"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startMatching = startMatching;
exports.removeFromQueue = removeFromQueue;
exports.processMatchmakerQueue = processMatchmakerQueue;
const uuid_1 = require("uuid");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const redis_1 = require("../config/redis");
const db_1 = require("../config/db");
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production_32chars';
/**
 * Pushes socket into FIFO queue & evaluates matchmaker queue
 */
async function startMatching(io, socket) {
    let userId = socket.data.user?.userId;
    if (!userId) {
        // Fallback token verification
        const token = socket.handshake.auth?.token ||
            socket.handshake.query?.token ||
            socket.handshake.headers?.authorization?.replace('Bearer ', '') ||
            socket.handshake.headers?.token;
        if (token) {
            try {
                const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
                userId = decoded.userId;
                socket.data.user = decoded;
            }
            catch (e) {
                console.error('Socket token verification failed in startMatching:', e);
            }
        }
    }
    if (!userId) {
        console.error(`Unauthorized start_matching attempt from socket ${socket.id}`);
        socket.emit('error', { message: 'Unauthorized socket. Please re-login.' });
        return;
    }
    console.log(`Socket ${socket.id} (User: ${userId}) joined matchmaking queue.`);
    // Remove existing queued entry if any
    await removeFromQueue(socket.id);
    const queueEntry = {
        socketId: socket.id,
        userId: userId,
    };
    // Push to Redis FIFO queue
    await redis_1.redis.rpush('queue:anonymous', JSON.stringify(queueEntry));
    socket.emit('matching_started', { status: 'Waiting for partner...' });
    // Evaluate queue
    await processMatchmakerQueue(io);
}
async function removeFromQueue(socketId) {
    try {
        const rawQueue = await redis_1.redis.lrange('queue:anonymous', 0, -1);
        for (const item of rawQueue) {
            const parsed = JSON.parse(item);
            if (parsed.socketId === socketId) {
                await redis_1.redis.lrem('queue:anonymous', 0, item);
            }
        }
    }
    catch (err) {
        console.error('Error removing socket from queue:', err);
    }
}
/**
 * Worker evaluating FIFO queue pairing
 */
async function processMatchmakerQueue(io) {
    try {
        const queueLength = await redis_1.redis.llen('queue:anonymous');
        console.log(`Evaluating matchmaker queue. Current queue length: ${queueLength}`);
        if (queueLength < 2)
            return;
        const firstRaw = await redis_1.redis.lpop('queue:anonymous');
        if (!firstRaw)
            return;
        const userA = JSON.parse(firstRaw);
        // Verify socket A is still connected
        const socketA = io.sockets.sockets.get(userA.socketId);
        if (!socketA || !socketA.connected) {
            console.log(`Socket A (${userA.socketId}) disconnected, processing next in queue...`);
            return processMatchmakerQueue(io);
        }
        // Try finding candidate B
        const remainingRaw = await redis_1.redis.lrange('queue:anonymous', 0, -1);
        let matchedCandidate = null;
        let candidateRawItem = null;
        for (const item of remainingRaw) {
            const candidate = JSON.parse(item);
            // Cannot pair socket with itself
            if (candidate.socketId === userA.socketId) {
                continue;
            }
            // Verify socket B is connected
            const socketB = io.sockets.sockets.get(candidate.socketId);
            if (!socketB || !socketB.connected) {
                await redis_1.redis.lrem('queue:anonymous', 0, item);
                continue;
            }
            // Check 2-Minute Temporary Block in Redis
            const isBlocked1 = await redis_1.redis.get(`temp_block:${userA.userId}:${candidate.userId}`);
            const isBlocked2 = await redis_1.redis.get(`temp_block:${candidate.userId}:${userA.userId}`);
            if (isBlocked1 || isBlocked2) {
                console.log(`Temp block active between User A (${userA.userId}) and Candidate B (${candidate.userId}). Skipping.`);
                continue;
            }
            matchedCandidate = candidate;
            candidateRawItem = item;
            break;
        }
        if (!matchedCandidate || !candidateRawItem) {
            // Re-push user A to queue
            await redis_1.redis.lpush('queue:anonymous', JSON.stringify(userA));
            return;
        }
        // Remove candidate B from queue
        await redis_1.redis.lrem('queue:anonymous', 0, candidateRawItem);
        const userB = matchedCandidate;
        const socketB = io.sockets.sockets.get(userB.socketId);
        if (!socketB || !socketB.connected) {
            await redis_1.redis.lpush('queue:anonymous', JSON.stringify(userA));
            return processMatchmakerQueue(io);
        }
        // Create session room
        const sessionId = (0, uuid_1.v4)();
        const roomName = `session:${sessionId}`;
        socketA.join(roomName);
        socketB.join(roomName);
        // Store active session mapping
        await redis_1.redis.hset(`session:${sessionId}`, {
            userA_socket: socketA.id,
            userB_socket: socketB.id,
            userA_id: userA.userId,
            userB_id: userB.userId,
            createdAt: Date.now().toString(),
        });
        await redis_1.redis.set(`active_session:${socketA.id}`, sessionId);
        await redis_1.redis.set(`active_session:${socketB.id}`, sessionId);
        // Fetch partners' star ratings from DB
        let ratingA = 5.0;
        let ratingB = 5.0;
        try {
            const ratingsResult = await (0, db_1.query)('SELECT id, total_stars, total_ratings FROM users WHERE id IN ($1, $2)', [userA.userId, userB.userId]);
            for (const row of ratingsResult.rows) {
                const avg = Number(row.total_stars) / Number(row.total_ratings);
                if (row.id === userA.userId && !isNaN(avg))
                    ratingA = parseFloat(avg.toFixed(2));
                if (row.id === userB.userId && !isNaN(avg))
                    ratingB = parseFloat(avg.toFixed(2));
            }
        }
        catch (e) {
            console.warn('Could not fetch ratings, using default 5.0:', e);
        }
        // Emit match_found
        socketA.emit('match_found', {
            sessionId,
            partnerUserId: userB.userId,
            partnerRating: ratingB,
            status: 'Partner connected!',
        });
        socketB.emit('match_found', {
            sessionId,
            partnerUserId: userA.userId,
            partnerRating: ratingA,
            status: 'Partner connected!',
        });
        console.log(`✨ MATCH SUCCESSFUL! Room ${sessionId} created for Socket A (${socketA.id}) and Socket B (${socketB.id})`);
    }
    catch (error) {
        console.error('Error processing matchmaker queue:', error);
    }
}
