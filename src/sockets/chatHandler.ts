import { Server, Socket } from 'socket.io';
import { redis } from '../config/redis';
import { deleteS3Folder } from '../config/storage';
import { startMatching, removeFromQueue } from './matchmaker';

// Rate limiting tracks per socket ID
const messageRateMap = new Map<string, number[]>();
const imageRateMap = new Map<string, number[]>();

// Disconnect grace timers (6-second disconnect timeout)
const graceTimers = new Map<string, NodeJS.Timeout>();

/**
 * Message Rate Limit Check:
 * Max 3 text messages per 1 second window
 * Max 1 image per 3 second window
 */
function checkRateLimit(socketId: string, type: 'text' | 'image'): boolean {
  const now = Date.now();

  if (type === 'text') {
    const timestamps = messageRateMap.get(socketId) || [];
    const recent = timestamps.filter((t) => now - t < 1000);
    if (recent.length >= 3) {
      return false; // Exceeded 3 msgs/sec limit
    }
    recent.push(now);
    messageRateMap.set(socketId, recent);
    return true;
  } else {
    const timestamps = imageRateMap.get(socketId) || [];
    const recent = timestamps.filter((t) => now - t < 3000);
    if (recent.length >= 1) {
      return false; // Exceeded 1 image / 3 sec limit
    }
    recent.push(now);
    imageRateMap.set(socketId, recent);
    return true;
  }
}

export function registerChatHandlers(io: Server, socket: Socket) {
  const userId = socket.data.user?.userId;

  // 1. Start Matchmaking Queue
  socket.on('start_matching', async () => {
    await startMatching(io, socket);
  });

  // 2. Cancel Matchmaking Queue
  socket.on('cancel_matching', async () => {
    await removeFromQueue(socket.id, userId);
    socket.emit('matching_cancelled');
  });

  // 3. Ephemeral RAM-Only Text Message
  socket.on('send_message', async (data: { sessionId: string; text: string; mediaUrl?: string }) => {
    const { sessionId, text, mediaUrl } = data;
    if (!sessionId) return;

    const isImage = !!mediaUrl;
    const allowed = checkRateLimit(socket.id, isImage ? 'image' : 'text');

    if (!allowed) {
      socket.emit('rate_limit_exceeded', {
        error: isImage ? 'Image upload rate limit exceeded (1 per 3s)' : 'Message rate limit exceeded (max 3/sec)',
      });
      return;
    }

    const roomName = `session:${sessionId}`;

    // Verify sender is part of this session before broadcasting
    const sessionData = await redis.hgetall(`session:${sessionId}`);
    if (!sessionData || (sessionData.userA_id !== userId && sessionData.userB_id !== userId)) {
      socket.emit('error', { message: 'You are not part of this session.' });
      return;
    }

    // Emit directly to room subscribers. NEVER save to PostgreSQL.
    io.to(roomName).emit('new_message', {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      senderId: userId,
      text: text || '',
      mediaUrl: mediaUrl || null,
      timestamp: new Date().toISOString(),
    });
  });

  // 4. Client Manual Leave Room
  socket.on('leave_room', async (data: { sessionId: string }) => {
    const { sessionId } = data;
    if (!sessionId) return;

    // Verify requesting user is part of the session
    const sessionData = await redis.hgetall(`session:${sessionId}`);
    if (sessionData && (sessionData.userA_id === userId || sessionData.userB_id === userId)) {
      await onRoomClosed(io, sessionId, 'User left chat session');
    }
  });

  // 5. Reconnect Session within Grace Period
  // Fixed: Updates Redis active_session key + session hash with new socket ID
  socket.on('reconnect_session', async (data: { sessionId: string }) => {
    const { sessionId } = data;
    if (!sessionId || !userId) {
      socket.emit('error', { message: 'Session ID and authentication required for reconnect.' });
      return;
    }

    const timer = graceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      graceTimers.delete(sessionId);

      // Join the session room with new socket
      socket.join(`session:${sessionId}`);

      // Update Redis: map new socket ID to the active session
      await redis.set(`active_session:${socket.id}`, sessionId);

      // Update session hash with new socket ID for this user
      const sessionData = await redis.hgetall(`session:${sessionId}`);
      if (sessionData) {
        if (sessionData.userA_id === userId) {
          await redis.hset(`session:${sessionId}`, 'userA_socket', socket.id);
        } else if (sessionData.userB_id === userId) {
          await redis.hset(`session:${sessionId}`, 'userB_socket', socket.id);
        }
      }

      socket.emit('session_restored', { sessionId });
      io.to(`session:${sessionId}`).emit('partner_reconnected');
      console.log(`Session ${sessionId} reconnected within grace period. New socket: ${socket.id}`);
    } else {
      // Grace period expired or session doesn't exist
      socket.emit('session_expired', { message: 'Session has expired. Please start a new match.' });
    }
  });

  // 6. Socket Disconnect Flow with 6-Second Grace Timeout
  socket.on('disconnect', async () => {
    messageRateMap.delete(socket.id);
    imageRateMap.delete(socket.id);
    await removeFromQueue(socket.id, userId);

    const sessionId = await redis.get(`active_session:${socket.id}`);
    if (sessionId) {
      await redis.del(`active_session:${socket.id}`);

      // Notify partner about temporary disconnect
      io.to(`session:${sessionId}`).emit('partner_temporarily_disconnected', {
        message: 'Partner may have lost connection. Waiting for reconnect...',
      });

      // Start 6-second disconnect grace timeout
      console.log(`Socket ${socket.id} disconnected. Starting 6-second grace timer for session ${sessionId}...`);
      
      const timer = setTimeout(async () => {
        graceTimers.delete(sessionId);
        await onRoomClosed(io, sessionId, 'Partner disconnected');
      }, 6000);

      graceTimers.set(sessionId, timer);
    }
  });
}

/**
 * Executes zero-footprint room closure and media destruction
 */
export async function onRoomClosed(io: Server, sessionId: string, reason: string) {
  try {
    const roomName = `session:${sessionId}`;

    // 1. Notify remaining socket in room
    io.to(roomName).emit('partner_disconnected', {
      status: 'Partner disconnected!',
      reason,
    });

    // 2. Delete all temporary image files from Cloudflare R2 / S3 storage
    const storagePrefix = `temp_chats/${sessionId}/`;
    await deleteS3Folder(storagePrefix);

    // 3. Clean up Redis session keys
    const sessionData = await redis.hgetall(`session:${sessionId}`);
    if (sessionData) {
      if (sessionData.userA_socket) await redis.del(`active_session:${sessionData.userA_socket}`);
      if (sessionData.userB_socket) await redis.del(`active_session:${sessionData.userB_socket}`);
      await redis.del(`session:${sessionId}`);
    }

    // 4. Force all sockets to leave the room
    const room = io.sockets.adapter.rooms.get(roomName);
    if (room) {
      for (const socketId of room) {
        const s = io.sockets.sockets.get(socketId);
        if (s) s.leave(roomName);
      }
    }

    console.log(`Room session ${sessionId} closed and wiped clean. Reason: ${reason}`);
  } catch (error) {
    console.error(`Error performing room closure for session ${sessionId}:`, error);
  }
}
