import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/db';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

/**
 * Helper to get Socket.IO instance from Express app.
 * Avoids circular import between server.ts and connectionController.ts.
 */
function getIO(req: AuthenticatedRequest) {
  return req.app.get('io');
}

export async function requestConnection(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { targetAppId } = req.body;

    if (!userId || !targetAppId) {
      return res.status(400).json({ error: 'Target App ID is required' });
    }

    const cleanAppId = targetAppId.trim().toUpperCase();

    // Verify target user exists
    const targetResult = await query('SELECT id FROM users WHERE app_id = $1', [cleanAppId]);
    if (targetResult.rows.length === 0) {
      return res.status(404).json({ error: 'User with this App ID not found' });
    }

    const targetUser = targetResult.rows[0];
    if (targetUser.id === userId) {
      return res.status(400).json({ error: 'Cannot connect with yourself' });
    }

    // Check permanent block table
    const blockCheck = await query(
      'SELECT id FROM permanent_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)',
      [userId, targetUser.id]
    );
    if (blockCheck.rows.length > 0) {
      return res.status(403).json({ error: 'Connection request blocked by user preferences' });
    }

    // Check existing connection
    const existingResult = await query(
      'SELECT id, status FROM connections WHERE (user_one = $1 AND user_two = $2) OR (user_one = $2 AND user_two = $1)',
      [userId, targetUser.id]
    );

    if (existingResult.rows.length > 0) {
      const conn = existingResult.rows[0];
      if (conn.status === 'accepted') {
        return res.status(400).json({ error: 'Already connected with this user' });
      } else if (conn.status === 'blocked') {
        return res.status(403).json({ error: 'Connection request blocked' });
      } else {
        return res.status(400).json({ error: 'Connection request already pending' });
      }
    }

    // Insert new pending connection request
    // user_one = sender, user_two = recipient
    const connectionId = uuidv4();
    const insertResult = await query(
      `INSERT INTO connections (id, user_one, user_two, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id, user_one, user_two, status, created_at`,
      [connectionId, userId, targetUser.id]
    );

    const createdConn = insertResult.rows[0] || {
      id: connectionId,
      user_one: userId,
      user_two: targetUser.id,
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    // Emit real-time socket notification to recipient
    const io = getIO(req);
    if (io) {
      io.to(`user:${targetUser.id}`).emit('connection_request_received', {
        connection: createdConn,
        senderUserId: userId,
      });
    }

    return res.status(201).json({
      message: 'Connection request sent successfully',
      connection: createdConn,
    });
  } catch (error) {
    console.error('Error requesting connection:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export async function respondConnection(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { connectionId, action, friendId } = req.body;

    if (!userId || (!connectionId && !friendId) || !action || !['accept', 'decline'].includes(action)) {
      return res.status(400).json({ error: 'Connection ID or friendId, and valid action required' });
    }

    let targetConnection: any = null;

    if (connectionId) {
      const connResult = await query(
        'SELECT id, user_one, user_two, status FROM connections WHERE id = $1 AND (user_one = $2 OR user_two = $2)',
        [connectionId, userId]
      );
      if (connResult.rows.length > 0) {
        targetConnection = connResult.rows[0];
      }
    }

    if (!targetConnection && friendId) {
      const connResult = await query(
        'SELECT id, user_one, user_two, status FROM connections WHERE ((user_one = $1 AND user_two = $2) OR (user_one = $2 AND user_two = $1)) AND status = \'pending\'',
        [userId, friendId]
      );
      if (connResult.rows.length > 0) {
        targetConnection = connResult.rows[0];
      }
    }

    if (!targetConnection) {
      return res.status(404).json({ error: 'Pending connection request not found' });
    }

    // SECURITY FIX: Only the RECIPIENT (user_two) can accept or decline a connection request.
    // The sender (user_one) must not be allowed to accept their own request.
    if (targetConnection.user_two !== userId) {
      return res.status(403).json({ error: 'Only the recipient can respond to a connection request' });
    }

    if (targetConnection.status !== 'pending') {
      return res.status(400).json({ error: `Connection is already ${targetConnection.status}` });
    }

    const realConnectionId = targetConnection.id;
    const senderId = targetConnection.user_one; // The original sender

    const io = getIO(req);

    if (action === 'accept') {
      await query(
        'UPDATE connections SET status = \'accepted\' WHERE id = $1',
        [realConnectionId]
      );

      // Notify the sender that their request was accepted (real-time)
      if (io) {
        io.to(`user:${senderId}`).emit('connection_accepted', {
          connectionId: realConnectionId,
          acceptedBy: userId,
        });
      }

      return res.status(200).json({ message: 'Connection request accepted' });
    } else {
      await query(
        'DELETE FROM connections WHERE id = $1',
        [realConnectionId]
      );

      // Notify the sender that their request was declined (real-time)
      if (io) {
        io.to(`user:${senderId}`).emit('connection_declined', {
          connectionId: realConnectionId,
          declinedBy: userId,
        });
      }

      return res.status(200).json({ message: 'Connection request declined' });
    }
  } catch (error) {
    console.error('Error responding to connection request:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getConnections(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Fetch accepted friends & pending incoming/outgoing requests, filtering out blocked users
    const queryText = `
      SELECT 
        c.id AS connection_id,
        c.status,
        c.created_at,
        c.user_one,
        c.user_two,
        u.id AS friend_id,
        u.username AS friend_username,
        u.app_id AS friend_app_id
      FROM connections c
      JOIN users u ON (u.id = CASE WHEN c.user_one = $1 THEN c.user_two ELSE c.user_one END)
      WHERE (c.user_one = $1 OR c.user_two = $1)
        AND c.status != 'blocked'
        AND u.id NOT IN (SELECT blocked_id FROM permanent_blocks WHERE blocker_id = $1)
        AND u.id NOT IN (SELECT blocker_id FROM permanent_blocks WHERE blocked_id = $1)
      ORDER BY c.created_at DESC
    `;

    const result = await query(queryText, [userId]);

    const rows = result.rows.map((row) => ({
      ...row,
      connection_id: String(row.connection_id),
    }));

    const accepted = rows.filter((r) => r.status === 'accepted');
    const pending = rows.filter((r) => r.status === 'pending');

    return res.status(200).json({ accepted, pending });
  } catch (error) {
    console.error('Error fetching connections:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getPersistentMessages(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { connectionId } = req.params;

    if (!userId || !connectionId) {
      return res.status(400).json({ error: 'Connection ID required' });
    }

    const connCheck = await query(
      'SELECT id FROM connections WHERE id = $1 AND (user_one = $2 OR user_two = $2) AND status = \'accepted\'',
      [connectionId, userId]
    );

    if (connCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Connection not found or not accepted' });
    }

    const targetConn = connCheck.rows[0];

    // Pagination: cursor-based using 'before' timestamp + limit
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const before = req.query.before as string;

    let messagesQuery = `SELECT id, connection_id, sender_id, message_text, media_url, created_at
       FROM persistent_messages
       WHERE connection_id = $1`;
    const params: any[] = [targetConn.id];

    if (before) {
      messagesQuery += ` AND created_at < $2`;
      params.push(before);
    }

    messagesQuery += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const messagesResult = await query(messagesQuery, params);

    // Reverse to chronological order for display
    const messages = messagesResult.rows.reverse();

    return res.status(200).json({
      messages,
      hasMore: messagesResult.rows.length === limit,
    });
  } catch (error) {
    console.error('Error fetching persistent messages:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export async function sendPersistentMessage(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { connectionId } = req.params;
    const { messageText, mediaUrl } = req.body;

    if (!userId || !connectionId || (!messageText && !mediaUrl)) {
      return res.status(400).json({ error: 'Message text or media URL required' });
    }

    const connCheck = await query(
      'SELECT id, user_one, user_two FROM connections WHERE id = $1 AND (user_one = $2 OR user_two = $2) AND status = \'accepted\'',
      [connectionId, userId]
    );

    if (connCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Active connection not found' });
    }

    const targetConn = connCheck.rows[0];
    const realConnId = targetConn.id;
    const receiverId = targetConn.user_one === userId ? targetConn.user_two : targetConn.user_one;

    const messageId = uuidv4();
    const result = await query(
      `INSERT INTO persistent_messages (id, connection_id, sender_id, message_text, media_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, connection_id, sender_id, message_text, media_url, created_at`,
      [messageId, realConnId, userId, messageText || null, mediaUrl || null]
    );

    const createdMsg = result.rows[0] || {
      id: messageId,
      connection_id: realConnId,
      sender_id: userId,
      message_text: messageText || null,
      media_url: mediaUrl || null,
      created_at: new Date().toISOString(),
    };

    // Emit real-time socket event to receiver
    const io = getIO(req);
    if (io) {
      io.to(`user:${receiverId}`).emit('new_persistent_message', createdMsg);
      // Also emit to sender for instant UI update without needing to refresh
      io.to(`user:${userId}`).emit('new_persistent_message', createdMsg);
    }

    return res.status(201).json({
      message: 'Message sent successfully',
      data: createdMsg,
    });
  } catch (error) {
    console.error('Error sending persistent message:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export async function permanentBlock(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { targetUserId } = req.body;

    if (!userId || !targetUserId) {
      return res.status(400).json({ error: 'Target user ID required' });
    }

    const blockId = uuidv4();
    await query(
      `INSERT INTO permanent_blocks (id, blocker_id, blocked_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [blockId, userId, targetUserId]
    );

    // Find and delete persistent messages for any connection between these users
    const connResult = await query(
      'SELECT id FROM connections WHERE (user_one = $1 AND user_two = $2) OR (user_one = $2 AND user_two = $1)',
      [userId, targetUserId]
    );

    for (const conn of connResult.rows) {
      await query('DELETE FROM persistent_messages WHERE connection_id = $1', [conn.id]);
    }

    // Remove the connection itself
    await query(
      'DELETE FROM connections WHERE (user_one = $1 AND user_two = $2) OR (user_one = $2 AND user_two = $1)',
      [userId, targetUserId]
    );

    return res.status(200).json({ message: 'User blocked permanently' });
  } catch (error) {
    console.error('Error blocking user permanently:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
