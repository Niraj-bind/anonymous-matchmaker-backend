"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tempBlock = tempBlock;
exports.ratePartner = ratePartner;
exports.reportUser = reportUser;
const redis_1 = require("../config/redis");
const db_1 = require("../config/db");
/**
 * 2-Minute Temporary Block (Layer 1 Redis-only)
 * Sets `temp_block:{userA_id}:{userB_id}` in Redis with TTL = 120s
 */
async function tempBlock(req, res) {
    try {
        const userId = req.user?.userId;
        const { targetUserId } = req.body;
        if (!userId || !targetUserId) {
            return res.status(400).json({ error: 'Target User ID is required' });
        }
        const key1 = `temp_block:${userId}:${targetUserId}`;
        const key2 = `temp_block:${targetUserId}:${userId}`;
        // Store in Redis with TTL = 120 seconds (2 minutes)
        await redis_1.redis.set(key1, '1', 'EX', 120);
        await redis_1.redis.set(key2, '1', 'EX', 120);
        return res.status(200).json({
            message: 'Temporary 2-minute block applied successfully in Redis cache',
            ttlSeconds: 120,
        });
    }
    catch (error) {
        console.error('Error applying temporary block:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
/**
 * Rate Anonymous Partner (1 to 5 Stars)
 */
async function ratePartner(req, res) {
    try {
        const { targetUserId, stars } = req.body;
        if (!targetUserId || stars === undefined) {
            return res.status(400).json({ error: 'Target User ID and stars are required' });
        }
        const ratingStars = parseInt(stars, 10);
        if (isNaN(ratingStars) || ratingStars < 1 || ratingStars > 5) {
            return res.status(400).json({ error: 'Rating stars must be an integer between 1 and 5' });
        }
        const updateResult = await (0, db_1.query)(`UPDATE users 
       SET total_stars = total_stars + $1, total_ratings = total_ratings + 1 
       WHERE id = $2 
       RETURNING id, total_stars, total_ratings`, [ratingStars, targetUserId]);
        if (updateResult.rows.length === 0) {
            return res.status(404).json({ error: 'Target user not found' });
        }
        const updatedUser = updateResult.rows[0];
        const newAverage = Number(updatedUser.total_stars) / Number(updatedUser.total_ratings);
        return res.status(200).json({
            message: 'Rating submitted successfully',
            newAverageRating: parseFloat(newAverage.toFixed(2)),
        });
    }
    catch (error) {
        console.error('Error rating partner:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
/**
 * Report Objectionable Content / User Violation
 * Saves RAM snapshot payload to reports table
 */
async function reportUser(req, res) {
    try {
        const reporterId = req.user?.userId;
        const { reportedUserId, reason, snapshotPayload } = req.body;
        if (!reporterId || !reportedUserId || !reason || !snapshotPayload) {
            return res.status(400).json({ error: 'Reporter, reported user, reason, and snapshot payload are required' });
        }
        await (0, db_1.query)(`INSERT INTO reports (reporter_id, reported_id, reason, snapshot_payload)
       VALUES ($1, $2, $3, $4)`, [reporterId, reportedUserId, reason, JSON.stringify(snapshotPayload)]);
        return res.status(201).json({
            message: 'Report submitted. Our moderation system will review the snapshot payload.',
        });
    }
    catch (error) {
        console.error('Error submitting report:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
