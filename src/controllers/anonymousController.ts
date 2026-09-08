import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { redis } from '../config/redis';
import { query } from '../config/db';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

/**
 * 2-Minute Temporary Block (Layer 1 Redis-only)
 * Sets `temp_block:{userA_id}:{userB_id}` in Redis with TTL = 120s
 */
export async function tempBlock(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { targetUserId } = req.body;

    if (!userId || !targetUserId) {
      return res.status(400).json({ error: 'Target User ID is required' });
    }

    const key1 = `temp_block:${userId}:${targetUserId}`;
    const key2 = `temp_block:${targetUserId}:${userId}`;

    // Store in Redis with TTL = 120 seconds (2 minutes)
    await redis.set(key1, '1', 'EX', 120);
    await redis.set(key2, '1', 'EX', 120);

    return res.status(200).json({
      message: 'Temporary 2-minute block applied successfully in Redis cache',
      ttlSeconds: 120,
    });
  } catch (error) {
    console.error('Error applying temporary block:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Rate Anonymous Partner (Deprecated / Disabled)
 */
export async function ratePartner(req: AuthenticatedRequest, res: Response) {
  return res.status(200).json({
    message: 'Rating system has been disabled.',
  });
}

/**
 * Report Objectionable Content / User Violation
 * Saves RAM snapshot payload to reports table
 */
export async function reportUser(req: AuthenticatedRequest, res: Response) {
  try {
    const reporterId = req.user?.userId;
    const { reportedUserId, reason, snapshotPayload } = req.body;

    if (!reporterId || !reportedUserId || !reason || !snapshotPayload) {
      return res.status(400).json({ error: 'Reporter, reported user, reason, and snapshot payload are required' });
    }

    const reportId = uuidv4();
    await query(
      `INSERT INTO reports (id, reporter_id, reported_id, reason, snapshot_payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [reportId, reporterId, reportedUserId, reason, JSON.stringify(snapshotPayload)]
    );

    return res.status(201).json({
      message: 'Report submitted. Our moderation system will review the snapshot payload.',
    });
  } catch (error) {
    console.error('Error submitting report:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
