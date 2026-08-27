import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { redis } from '../config/redis';
import { query } from '../config/db';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production_32chars';

export interface QueueEntry {
  socketId: string;
  userId: string;
}

/**
 * Pushes socket into FIFO queue & evaluates matchmaker queue
 */
export async function startMatching(io: Server, socket: Socket) {
  let userId = socket.data.user?.userId;

  if (!userId) {
    // Fallback token verification
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token ||
      socket.handshake.headers?.authorization?.replace('Bearer ', '') ||
      socket.handshake.headers?.token;

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        userId = decoded.userId;
        socket.data.user = decoded;
      } catch (e) {
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

  const queueEntry: QueueEntry = {
    socketId: socket.id,
    userId: userId,
  };

  // Push to Redis FIFO queue
  await redis.rpush('queue:anonymous', JSON.stringify(queueEntry));
  socket.emit('matching_started', { status: 'Waiting for partner...' });

  // Evaluate queue
  await processMatchmakerQueue(io);
}

export async function removeFromQueue(socketId: string, userId?: string) {
  try {
    const rawQueue = await redis.lrange('queue:anonymous', 0, -1);
    for (const item of rawQueue) {
      const parsed: QueueEntry = JSON.parse(item);
      if (parsed.socketId === socketId || (userId && parsed.userId === userId)) {
        await redis.lrem('queue:anonymous', 0, item);
      }
    }
  } catch (err) {
    console.error('Error removing socket from queue:', err);
  }
}

/**
 * Worker evaluating FIFO queue pairing
 */
export async function processMatchmakerQueue(io: Server) {
  try {
    const queueLength = await redis.llen('queue:anonymous');
    console.log(`Evaluating matchmaker queue. Current queue length: ${queueLength}`);
    if (queueLength < 2) return;

    const firstRaw = await redis.lpop('queue:anonymous');
    if (!firstRaw) return;
    const userA: QueueEntry = JSON.parse(firstRaw);

    // Verify socket A is still connected
    const socketA = io.sockets.sockets.get(userA.socketId);
    if (!socketA || !socketA.connected) {
      console.log(`Socket A (${userA.socketId}) disconnected, processing next in queue...`);
      return processMatchmakerQueue(io);
    }

    // Try finding candidate B
    const remainingRaw = await redis.lrange('queue:anonymous', 0, -1);
    let matchedCandidate: QueueEntry | null = null;
    let candidateRawItem: string | null = null;

    for (const item of remainingRaw) {
      const candidate: QueueEntry = JSON.parse(item);

      // Cannot pair socket with itself or user with themselves
      if (candidate.socketId === userA.socketId || candidate.userId === userA.userId) {
        continue;
      }

      // Verify socket B is connected
      const socketB = io.sockets.sockets.get(candidate.socketId);
      if (!socketB || !socketB.connected) {
        await redis.lrem('queue:anonymous', 0, item);
        continue;
      }

      // Check 2-Minute Temporary Block in Redis
      const isBlocked1 = await redis.get(`temp_block:${userA.userId}:${candidate.userId}`);
      const isBlocked2 = await redis.get(`temp_block:${candidate.userId}:${userA.userId}`);

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
      await redis.lpush('queue:anonymous', JSON.stringify(userA));
      return;
    }

    // Remove candidate B from queue
    await redis.lrem('queue:anonymous', 0, candidateRawItem);

    const userB = matchedCandidate;
    const socketB = io.sockets.sockets.get(userB.socketId);

    if (!socketB || !socketB.connected) {
      await redis.lpush('queue:anonymous', JSON.stringify(userA));
      return processMatchmakerQueue(io);
    }

    // Create session room
    const sessionId = uuidv4();
    const roomName = `session:${sessionId}`;

    socketA.join(roomName);
    socketB.join(roomName);

    // Store active session mapping
    await redis.hset(`session:${sessionId}`, {
      userA_socket: socketA.id,
      userB_socket: socketB.id,
      userA_id: userA.userId,
      userB_id: userB.userId,
      createdAt: Date.now().toString(),
    });

    await redis.set(`active_session:${socketA.id}`, sessionId);
    await redis.set(`active_session:${socketB.id}`, sessionId);

    // Fetch partners' star ratings from DB
    let ratingA = 5.0;
    let ratingB = 5.0;

    try {
      const ratingsResult = await query(
        'SELECT id, total_stars, total_ratings FROM users WHERE id IN ($1, $2)',
        [userA.userId, userB.userId]
      );

      for (const row of ratingsResult.rows) {
        const avg = Number(row.total_stars) / Number(row.total_ratings);
        if (row.id === userA.userId && !isNaN(avg)) ratingA = parseFloat(avg.toFixed(2));
        if (row.id === userB.userId && !isNaN(avg)) ratingB = parseFloat(avg.toFixed(2));
      }
    } catch (e) {
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
  } catch (error) {
    console.error('Error processing matchmaker queue:', error);
  }
}
