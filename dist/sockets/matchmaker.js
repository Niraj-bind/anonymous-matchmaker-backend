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
    // Remove existing queued entry for this socket OR user if any
    await removeFromQueue(socket.id, userId);
    const queueEntry = {
        socketId: socket.id,
        userId: userId,
    };
    // Push to Redis FIFO queue
    await redis_1.redis.rpush('queue:anonymous', JSON.stringify(queueEntry));
    socket.emit('matching_started', { status: 'Waiting for partner...' });
    // Evaluate queue immediately
    await processMatchmakerQueue(io);
}
/**
 * Removes a socket/user from the matchmaking queue using atomic LREM operations.
 * Each LREM call is atomic — no risk of queue corruption from concurrent access.
 */
async function removeFromQueue(socketId, userId) {
    try {
        const rawQueue = await redis_1.redis.lrange('queue:anonymous', 0, -1);
        if (!rawQueue || rawQueue.length === 0)
            return;
        for (const item of rawQueue) {
            try {
                const parsed = JSON.parse(item);
                if (parsed.socketId === socketId || (userId && parsed.userId === userId)) {
                    // LREM is atomic — safely removes the exact item from the list
                    await redis_1.redis.lrem('queue:anonymous', 0, item);
                }
            }
            catch (e) {
                // Malformed entry — remove it
                await redis_1.redis.lrem('queue:anonymous', 0, item);
            }
        }
    }
    catch (err) {
        console.error('Error removing socket from queue:', err);
    }
}
let isProcessing = false;
/**
 * Iterative worker evaluating FIFO queue pairing.
 * Uses a while loop instead of recursion to avoid stack overflow.
 * Limited to MAX_ITERATIONS to prevent infinite loops.
 */
async function processMatchmakerQueue(io) {
    if (isProcessing) {
        return; // Another cycle is already actively pairing sockets
    }
    isProcessing = true;
    const MAX_ITERATIONS = 50; // Safety cap to prevent infinite loops
    let iterations = 0;
    try {
        while (iterations < MAX_ITERATIONS) {
            iterations++;
            const queueLength = await redis_1.redis.llen('queue:anonymous');
            if (queueLength < 2)
                break;
            console.log(`Evaluating matchmaker queue. Current queue length: ${queueLength}`);
            const firstRaw = await redis_1.redis.lpop('queue:anonymous');
            if (!firstRaw)
                return;
            let userA;
            try {
                userA = JSON.parse(firstRaw);
            }
            catch (e) {
                // Malformed entry, skip and continue to next iteration
                continue;
            }
            // Verify socket A is still connected
            const socketA = io.sockets.sockets.get(userA.socketId);
            if (!socketA || !socketA.connected) {
                console.log(`Socket A (${userA.socketId}) disconnected, processing next in queue...`);
                continue;
            }
            // Try finding candidate B
            const remainingRaw = await redis_1.redis.lrange('queue:anonymous', 0, -1);
            let matchedCandidate = null;
            let candidateRawItem = null;
            for (const item of remainingRaw) {
                let candidate;
                try {
                    candidate = JSON.parse(item);
                }
                catch (e) {
                    // Remove malformed entry
                    await redis_1.redis.lrem('queue:anonymous', 0, item);
                    continue;
                }
                // Cannot pair socket with itself or user with themselves
                if (candidate.socketId === userA.socketId || candidate.userId === userA.userId) {
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
                // Check Permanent Block in PostgreSQL
                try {
                    const permBlockCheck = await (0, db_1.query)('SELECT id FROM permanent_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)', [userA.userId, candidate.userId]);
                    if (permBlockCheck.rows.length > 0) {
                        console.log(`Permanent block active between User A (${userA.userId}) and Candidate B (${candidate.userId}). Skipping.`);
                        continue;
                    }
                }
                catch (e) {
                    console.warn('Could not check permanent blocks, proceeding with match:', e);
                }
                matchedCandidate = candidate;
                candidateRawItem = item;
                break;
            }
            if (!matchedCandidate || !candidateRawItem) {
                // Re-push user A to front of queue
                await redis_1.redis.lpush('queue:anonymous', JSON.stringify(userA));
                return;
            }
            // Remove candidate B from queue atomically
            await redis_1.redis.lrem('queue:anonymous', 0, candidateRawItem);
            const userB = matchedCandidate;
            const socketB = io.sockets.sockets.get(userB.socketId);
            if (!socketB || !socketB.connected) {
                await redis_1.redis.lpush('queue:anonymous', JSON.stringify(userA));
                continue;
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
            const payloadA = {
                sessionId,
                partnerUserId: userB.userId,
                partnerRating: ratingB,
                status: 'Partner connected!',
            };
            const payloadB = {
                sessionId,
                partnerUserId: userA.userId,
                partnerRating: ratingA,
                status: 'Partner connected!',
            };
            // Emit match_found — single emit per socket (no duplicates)
            socketA.emit('match_found', payloadA);
            socketB.emit('match_found', payloadB);
            console.log(`✨ MATCH SUCCESSFUL! Room ${sessionId} created for Socket A (${socketA.id}) and Socket B (${socketB.id})`);
            // Continue loop to check if more users are waiting in queue
        }
        if (iterations >= MAX_ITERATIONS) {
            console.warn('Matchmaker hit max iterations safety cap. Will process remaining in next cycle.');
        }
    }
    catch (error) {
        console.error('Error processing matchmaker queue:', error);
    }
    finally {
        isProcessing = false;
    }
}
