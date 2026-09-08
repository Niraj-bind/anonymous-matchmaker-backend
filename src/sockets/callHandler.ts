import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/db';
import { redis } from '../config/redis';
import { getIceServers } from '../config/iceServers';
import { sendAndroidIncomingCallPush, sendAndroidCallEndedPush } from '../config/fcm';

/**
 * WebRTC Voice Calling Signaling Handler
 * Robust Android-resilient WebRTC signaling:
 * - Tolerates mobile socket reconnection on activity/screen switches
 * - Disconnect grace period prevents premature call termination
 * - Multi-alias event payloads for maximum Flutter WebRTC compatibility
 */
export function registerCallHandlers(io: Server, socket: Socket) {
  const userId = socket.data.user?.userId;

  // 0. Dynamic ICE Servers Request
  socket.on('get_ice_servers', () => {
    socket.emit('ice_servers', { iceServers: getIceServers() });
  });

  // 1. Initiate Voice Call (Caller -> Callee)
  socket.on('call_user', async (data: { targetUserId?: string; targetId?: string; peerId?: string; connectionId: string; isVideo?: boolean }) => {
    try {
      const targetUserId = data.targetUserId || data.targetId || data.peerId;
      const { connectionId, isVideo } = data;

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

      // Check if target user is currently in another active call with someone else
      const calleeActiveCall = await redis.get(`active_call:${targetUserId}`);
      if (calleeActiveCall) {
        try {
          const parsed = JSON.parse(calleeActiveCall);
          if (parsed.peerId && parsed.peerId !== userId) {
            socket.emit('call_rejected', {
              targetUserId,
              reason: 'busy',
              message: 'User is currently on another call',
            });
            return;
          }
        } catch (e) {}
      }

      // Fetch caller details to display on callee screen
      const callerResult = await query('SELECT username, app_id FROM users WHERE id = $1', [userId]);
      const callerInfo = callerResult.rows[0] || {};

      const callId = uuidv4();
      const iceServers = getIceServers();

      // Track active call state in Redis (TTL = 1 hour)
      await redis.set(`active_call:${userId}`, JSON.stringify({ callId, peerId: targetUserId, role: 'caller' }), 'EX', 3600);
      await redis.set(`active_call:${targetUserId}`, JSON.stringify({ callId, peerId: userId, role: 'callee' }), 'EX', 3600);

      console.log(`📞 Voice Call initiated: ${userId} (${callerInfo.username}) calling ${targetUserId} (Call ID: ${callId})`);

      // Provide ICE configuration directly to caller
      socket.emit('call_initiated', {
        callId,
        targetUserId,
        peerId: targetUserId,
        iceServers,
      });

      const incomingPayload = {
        callId,
        callerUserId: userId,
        callerId: userId,
        peerId: userId,
        callerUsername: callerInfo.username || 'Anonymous Friend',
        callerAppId: callerInfo.app_id || '',
        connectionId,
        isVideo: !!isVideo,
        iceServers,
        timestamp: new Date().toISOString(),
      };

      // Emit incoming_call event to recipient room
      io.to(`user:${targetUserId}`).emit('incoming_call', incomingPayload);

      // Android Background VoIP / Full-Screen Ringtone Push
      try {
        const calleeResult = await query('SELECT fcm_token FROM users WHERE id = $1', [targetUserId]);
        const targetFcmToken = calleeResult.rows[0]?.fcm_token;
        if (targetFcmToken) {
          sendAndroidIncomingCallPush(targetFcmToken, {
            callId,
            callerUserId: userId,
            callerUsername: callerInfo.username || 'Anonymous Friend',
            callerAppId: callerInfo.app_id || '',
            connectionId,
            isVideo: !!isVideo,
          }).catch((err) => console.warn('FCM call push warning:', err));
        }
      } catch (fcmErr) {
        console.warn('Could not dispatch Android call push:', fcmErr);
      }
    } catch (error) {
      console.error('Error initiating call:', error);
      socket.emit('call_error', { message: 'Internal server error while initiating call' });
    }
  });

  // 2. Accept Incoming Call (Callee -> Caller)
  socket.on('accept_call', async (data: { callerUserId?: string; callerId?: string; targetUserId?: string; peerId?: string; callId: string }) => {
    try {
      const callerUserId = data.callerUserId || data.callerId || data.targetUserId || data.peerId;
      const callId = data.callId;

      if (!userId || !callerUserId || !callId) {
        console.warn(`accept_call missing parameters: userId=${userId}, callerUserId=${callerUserId}, callId=${callId}`);
        return;
      }

      console.log(`✅ Voice Call accepted by ${userId} from caller ${callerUserId} (Call ID: ${callId})`);
      const iceServers = getIceServers();

      const callerPayload = {
        callId,
        acceptedBy: userId,
        peerId: userId,
        targetUserId: userId,
        callerUserId,
        calleeUserId: userId,
        role: 'caller',
        isInitiator: true,
        iceServers,
        status: 'connected',
      };

      const calleePayload = {
        callId,
        acceptedBy: userId,
        peerId: callerUserId,
        targetUserId: callerUserId,
        callerUserId,
        calleeUserId: userId,
        role: 'callee',
        isInitiator: false,
        iceServers,
        status: 'connected',
      };

      // 1. Notify CALLER only with call_accepted. Caller is the initiator and will create the WebRTC offer.
      io.to(`user:${callerUserId}`).emit('call_accepted', callerPayload);

      // 2. Confirm to CALLEE only with call_connected. Callee will prepare audio and wait for incoming offer.
      // (NEVER send call_accepted to Callee to avoid WebRTC Glare / double offer collisions!)
      socket.emit('call_connected', calleePayload);
      io.to(`user:${userId}`).emit('call_connected', calleePayload);
    } catch (error) {
      console.error('Error accepting call:', error);
    }
  });

  // 3. Reject / Decline Call (Callee -> Caller)
  socket.on('reject_call', async (data: { callerUserId?: string; callerId?: string; targetUserId?: string; peerId?: string; callId: string; reason?: string }) => {
    try {
      const callerUserId = data.callerUserId || data.callerId || data.targetUserId || data.peerId;
      const { callId, reason } = data;
      if (!userId || !callerUserId) return;

      console.log(`❌ Voice Call rejected by ${userId} (Caller: ${callerUserId}, Reason: ${reason || 'declined'})`);

      // Clean active call mapping
      await redis.del(`active_call:${userId}`);
      await redis.del(`active_call:${callerUserId}`);

      const rejectPayload = {
        callId,
        rejectedBy: userId,
        reason: reason || 'declined',
      };

      io.to(`user:${callerUserId}`).emit('call_rejected', rejectPayload);
      socket.emit('call_rejected', rejectPayload);

      // Notify Android device to dismiss incoming call screen
      try {
        const callerDb = await query('SELECT fcm_token FROM users WHERE id = $1', [callerUserId]);
        const callerFcmToken = callerDb.rows[0]?.fcm_token;
        if (callerFcmToken && callId) {
          sendAndroidCallEndedPush(callerFcmToken, { callId, reason: reason || 'declined' }).catch(() => {});
        }
      } catch (e) {}
    } catch (error) {
      console.error('Error rejecting call:', error);
    }
  });

  // 4. WebRTC SDP Offer Relay (Caller -> Callee)
  const handleOffer = (data: { targetUserId?: string; targetId?: string; peerId?: string; calleeUserId?: string; sdp: any; callId: string; type?: string }) => {
    const targetUserId = data.targetUserId || data.targetId || data.peerId || data.calleeUserId;
    const { sdp, callId } = data;
    if (!userId || !targetUserId || !sdp) return;

    console.log(`📨 WebRTC Offer Relayed: from ${userId} -> to ${targetUserId}`);

    const payload = {
      senderId: userId,
      callerUserId: userId,
      peerId: userId,
      targetUserId,
      sdp,
      type: data.type || (sdp && sdp.type) || 'offer',
      callId,
    };

    io.to(`user:${targetUserId}`).emit('webrtc_offer', payload);
    io.to(`user:${targetUserId}`).emit('offer', payload);
  };

  socket.on('webrtc_offer', handleOffer);
  socket.on('offer', handleOffer);

  // 5. WebRTC SDP Answer Relay (Callee -> Caller)
  const handleAnswer = (data: { targetUserId?: string; targetId?: string; peerId?: string; callerUserId?: string; sdp: any; callId: string; type?: string }) => {
    const targetUserId = data.targetUserId || data.targetId || data.peerId || data.callerUserId;
    const { sdp, callId } = data;
    if (!userId || !targetUserId || !sdp) return;

    console.log(`📨 WebRTC Answer Relayed: from ${userId} -> to ${targetUserId}`);

    const payload = {
      senderId: userId,
      calleeUserId: userId,
      peerId: userId,
      targetUserId,
      sdp,
      type: data.type || (sdp && sdp.type) || 'answer',
      callId,
    };

    io.to(`user:${targetUserId}`).emit('webrtc_answer', payload);
    io.to(`user:${targetUserId}`).emit('answer', payload);
  };

  socket.on('webrtc_answer', handleAnswer);
  socket.on('answer', handleAnswer);

  // 6. WebRTC ICE Candidate Relay (Bidirectional)
  const handleIceCandidate = (data: { targetUserId?: string; targetId?: string; peerId?: string; candidate: any; callId: string }) => {
    const targetUserId = data.targetUserId || data.targetId || data.peerId;
    const { candidate, callId } = data;
    if (!userId || !targetUserId || !candidate) return;

    const payload = {
      senderId: userId,
      peerId: userId,
      targetUserId,
      candidate,
      callId,
    };

    io.to(`user:${targetUserId}`).emit('ice_candidate', payload);
    io.to(`user:${targetUserId}`).emit('webrtc_ice_candidate', payload);
    io.to(`user:${targetUserId}`).emit('candidate', payload);
  };

  socket.on('ice_candidate', handleIceCandidate);
  socket.on('webrtc_ice_candidate', handleIceCandidate);
  socket.on('candidate', handleIceCandidate);

  // 7. End Call / Hang Up
  socket.on('end_call', async (data: { targetUserId?: string; peerId?: string; targetId?: string; callId?: string; reason?: string }) => {
    try {
      const targetUserId = data?.targetUserId || data?.peerId || data?.targetId;
      const callId = data?.callId;
      if (!userId) return;

      console.log(`📴 Voice Call ended by ${userId}`);

      if (userId) await redis.del(`active_call:${userId}`);
      if (targetUserId) await redis.del(`active_call:${targetUserId}`);

      const endPayload = {
        endedBy: userId,
        callId,
        reason: data?.reason || 'normal',
      };

      if (targetUserId) {
        io.to(`user:${targetUserId}`).emit('call_ended', endPayload);
      }
      io.to(`user:${userId}`).emit('call_ended', endPayload);

      // Dismiss Android call UI
      if (targetUserId) {
        try {
          const calleeDb = await query('SELECT fcm_token FROM users WHERE id = $1', [targetUserId]);
          const calleeFcmToken = calleeDb.rows[0]?.fcm_token;
          if (calleeFcmToken && callId) {
            sendAndroidCallEndedPush(calleeFcmToken, { callId, reason: 'ended' }).catch(() => {});
          }
        } catch (e) {}
      }
    } catch (error) {
      console.error('Error ending call:', error);
    }
  });

  // 8. Disconnect Auto-Cleanup with 10-Second Grace Period
  // On mobile Android, when an incoming call screen opens or app transitions activities,
  // the socket might momentarily drop and reconnect. We NEVER terminate the call immediately!
  socket.on('disconnect', async () => {
    if (!userId) return;

    // Check if user still has other connected sockets in their room
    const userRoom = io.sockets.adapter.rooms.get(`user:${userId}`);
    if (userRoom && userRoom.size > 0) {
      console.log(`Socket ${socket.id} disconnected, but User ${userId} has ${userRoom.size} active socket(s). Call preserved.`);
      return;
    }

    // Give 10 seconds grace period for Android mobile reconnection
    setTimeout(async () => {
      try {
        const stillConnected = io.sockets.adapter.rooms.get(`user:${userId}`);
        if (stillConnected && stillConnected.size > 0) {
          console.log(`User ${userId} reconnected within grace period. Call preserved.`);
          return;
        }

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
            console.log(`📴 Call ended after 10s disconnect grace period for User ${userId}`);
          }
        }
      } catch (e) {
        // Ignore cleanup error
      }
    }, 10000);
  });
}
