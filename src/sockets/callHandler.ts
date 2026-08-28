import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/db';
import { redis } from '../config/redis';

/**
 * WebRTC Voice Calling Signaling Handler
 * Manages 1-on-1 voice call state, offers, answers, and ICE candidate relaying.
 */
export function registerCallHandlers(io: Server, socket: Socket) {
  const userId = socket.data.user?.userId;

  // 1. Initiate Voice Call (Caller -> Callee)
  socket.on('call_user', async (data: { targetUserId: string; connectionId: string; isVideo?: boolean }) => {
    try {
      const { targetUserId, connectionId, isVideo } = data;

      if (!userId || !targetUserId || !connectionId) {
        socket.emit('call_error', { message: 'Target user and connection ID are required' });
        return;
      }

      if (userId === targetUserId) {
        socket.emit('call_error', { message: 'Cannot call yourself' });
        return;
      }

      // Security Check: Verify both users have an active accepted connection in DB
      const connCheck = await query(
        `SELECT id FROM connections 
         WHERE id = $1 AND ((user_one = $2 AND user_two = $3) OR (user_one = $3 AND user_two = $2))
           AND status = 'accepted'`,
        [connectionId, userId, targetUserId]
      );

      if (connCheck.rows.length === 0) {
        socket.emit('call_error', { message: 'You can only call accepted connections' });
        return;
      }

      // Check if target user is currently in another active call
      const calleeActiveCall = await redis.get(`active_call:${targetUserId}`);
      if (calleeActiveCall) {
        socket.emit('call_rejected', {
          targetUserId,
          reason: 'busy',
          message: 'User is currently on another call',
        });
        return;
      }

      // Fetch caller details to display on callee screen
      const callerResult = await query('SELECT username, app_id FROM users WHERE id = $1', [userId]);
      const callerInfo = callerResult.rows[0] || {};

      const callId = uuidv4();

      // Track active call state in Redis (TTL = 2 hours max call timeout)
      await redis.set(`active_call:${userId}`, JSON.stringify({ callId, peerId: targetUserId, role: 'caller' }), 'EX', 7200);
      await redis.set(`active_call:${targetUserId}`, JSON.stringify({ callId, peerId: userId, role: 'callee' }), 'EX', 7200);

      console.log(`📞 Voice Call initiated: ${userId} (${callerInfo.username}) calling ${targetUserId} (Call ID: ${callId})`);

      // Emit incoming_call event to recipient room
      io.to(`user:${targetUserId}`).emit('incoming_call', {
        callId,
        callerUserId: userId,
        callerUsername: callerInfo.username,
        callerAppId: callerInfo.app_id,
        connectionId,
        isVideo: !!isVideo,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error initiating call:', error);
      socket.emit('call_error', { message: 'Internal server error while initiating call' });
    }
  });

  // 2. Accept Incoming Call (Callee -> Caller)
  socket.on('accept_call', async (data: { callerUserId: string; callId: string }) => {
    try {
      const { callerUserId, callId } = data;
      if (!userId || !callerUserId || !callId) return;

      console.log(`✅ Voice Call accepted by ${userId} from caller ${callerUserId} (Call ID: ${callId})`);

      io.to(`user:${callerUserId}`).emit('call_accepted', {
        callId,
        acceptedBy: userId,
      });
    } catch (error) {
      console.error('Error accepting call:', error);
    }
  });

  // 3. Reject / Decline Call (Callee -> Caller)
  socket.on('reject_call', async (data: { callerUserId: string; callId: string; reason?: string }) => {
    try {
      const { callerUserId, callId, reason } = data;
      if (!userId || !callerUserId) return;

      console.log(`❌ Voice Call rejected by ${userId} (Caller: ${callerUserId}, Reason: ${reason || 'declined'})`);

      // Clean active call mapping
      await redis.del(`active_call:${userId}`);
      await redis.del(`active_call:${callerUserId}`);

      io.to(`user:${callerUserId}`).emit('call_rejected', {
        callId,
        rejectedBy: userId,
        reason: reason || 'declined',
      });
    } catch (error) {
      console.error('Error rejecting call:', error);
    }
  });

  // 4. WebRTC SDP Offer Relay (Caller -> Callee)
  socket.on('webrtc_offer', (data: { targetUserId: string; sdp: any; callId: string }) => {
    const { targetUserId, sdp, callId } = data;
    if (!userId || !targetUserId || !sdp) return;

    io.to(`user:${targetUserId}`).emit('webrtc_offer', {
      senderId: userId,
      sdp,
      callId,
    });
  });

  // 5. WebRTC SDP Answer Relay (Callee -> Caller)
  socket.on('webrtc_answer', (data: { targetUserId: string; sdp: any; callId: string }) => {
    const { targetUserId, sdp, callId } = data;
    if (!userId || !targetUserId || !sdp) return;

    io.to(`user:${targetUserId}`).emit('webrtc_answer', {
      senderId: userId,
      sdp,
      callId,
    });
  });

  // 6. WebRTC ICE Candidate Relay (Bidirectional)
  socket.on('ice_candidate', (data: { targetUserId: string; candidate: any; callId: string }) => {
    const { targetUserId, candidate, callId } = data;
    if (!userId || !targetUserId || !candidate) return;

    io.to(`user:${targetUserId}`).emit('ice_candidate', {
      senderId: userId,
      candidate,
      callId,
    });
  });

  // 7. End Call / Hang Up
  socket.on('end_call', async (data: { targetUserId: string; callId?: string }) => {
    try {
      const { targetUserId, callId } = data;
      if (!userId) return;

      console.log(`📴 Voice Call ended by ${userId}`);

      if (userId) await redis.del(`active_call:${userId}`);
      if (targetUserId) await redis.del(`active_call:${targetUserId}`);

      if (targetUserId) {
        io.to(`user:${targetUserId}`).emit('call_ended', {
          endedBy: userId,
          callId,
          reason: 'normal',
        });
      }
    } catch (error) {
      console.error('Error ending call:', error);
    }
  });

  // 8. Disconnect Auto-Cleanup for In-Call Users
  socket.on('disconnect', async () => {
    if (!userId) return;
    try {
      const activeCallRaw = await redis.get(`active_call:${userId}`);
      if (activeCallRaw) {
        const activeCall = JSON.parse(activeCallRaw);
        await redis.del(`active_call:${userId}`);
        if (activeCall.peerId) {
          await redis.del(`active_call:${activeCall.peerId}`);
          io.to(`user:${activeCall.peerId}`).emit('call_ended', {
            endedBy: userId,
            callId: activeCall.callId,
            reason: 'disconnected',
          });
          console.log(`📴 Call automatically ended due to disconnect of user ${userId}`);
        }
      }
    } catch (e) {
      // Ignore cleanup error
    }
  });
}
