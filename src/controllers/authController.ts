import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/db';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production_32chars';

/**
 * Custom character set excluding ambiguous characters (0, O, 1, I)
 * [2-9A-HJ-NP-Z]
 */
const APP_ID_CHARSET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function generateAppId(): string {
  let result = '';
  for (let i = 0; i < 6; i++) {
    const randomIndex = Math.floor(Math.random() * APP_ID_CHARSET.length);
    result += APP_ID_CHARSET[randomIndex];
  }
  return result;
}

async function generateUniqueAppId(): Promise<string> {
  let isUnique = false;
  let appId = '';
  let attempts = 0;

  while (!isUnique && attempts < 10) {
    appId = generateAppId();
    const existing = await query('SELECT id FROM users WHERE app_id = $1', [appId]);
    if (existing.rows.length === 0) {
      isUnique = true;
    }
    attempts++;
  }

  if (!isUnique) {
    throw new Error('Failed to generate unique App ID');
  }

  return appId;
}

export async function register(req: Request, res: Response) {
  try {
    const { username, password, age, gender } = req.body;

    if (!username || !password || age === undefined || !gender) {
      return res.status(400).json({ error: 'Username, password, age, and gender are required' });
    }

    if (username.trim().length < 3 || username.trim().length > 32) {
      return res.status(400).json({ error: 'Username must be between 3 and 32 characters' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const parsedAge = parseInt(age, 10);
    if (isNaN(parsedAge) || parsedAge < 18) {
      return res.status(400).json({ error: 'You must be at least 18 years old' });
    }

    if (gender !== 'man' && gender !== 'woman') {
      return res.status(400).json({ error: 'Gender must be either "man" or "woman"' });
    }

    // Check if username exists
    const userCheck = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (userCheck.rows.length > 0) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    // Generate explicit UUID for user.id to guarantee non-null ID in SQLite & Postgres
    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);
    const appId = await generateUniqueAppId();

    const insertResult = await query(
      `INSERT INTO users (id, username, password_hash, app_id, age, gender, total_stars, total_ratings)
       VALUES ($1, $2, $3, $4, $5, $6, 5, 1)
       RETURNING id, username, app_id, age, gender, total_stars, total_ratings, created_at`,
      [userId, username, passwordHash, appId, parsedAge, gender]
    );

    const newUser = insertResult.rows[0] || {
      id: userId,
      username,
      app_id: appId,
      age: parsedAge,
      gender,
      total_stars: 5,
      total_ratings: 1,
      created_at: new Date().toISOString(),
    };

    const token = jwt.sign({ userId: newUser.id || userId, appId: newUser.app_id || appId }, JWT_SECRET, { expiresIn: '30d' });

    const rating = Number(newUser.total_stars || 5) / Number(newUser.total_ratings || 1);

    return res.status(201).json({
      token,
      user: {
        id: newUser.id || userId,
        username: newUser.username || username,
        appId: newUser.app_id || appId,
        age: newUser.age || parsedAge,
        gender: newUser.gender || gender,
        rating: parseFloat(rating.toFixed(2)),
        createdAt: newUser.created_at || new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Error during user registration:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export async function login(req: Request, res: Response) {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const userResult = await query('SELECT * FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = userResult.rows[0];
    const passwordValid = await bcrypt.compare(password, user.password_hash);

    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign({ userId: user.id, appId: user.app_id }, JWT_SECRET, { expiresIn: '30d' });
    const rating = Number(user.total_stars) / Number(user.total_ratings);

    return res.status(200).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        appId: user.app_id,
        age: user.age,
        gender: user.gender,
        rating: parseFloat(rating.toFixed(2)),
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    console.error('Error during login:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getMe(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const userResult = await query(
      'SELECT id, username, app_id, age, gender, total_stars, total_ratings, created_at FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const rating = Number(user.total_stars) / Number(user.total_ratings);

    return res.status(200).json({
      user: {
        id: user.id,
        username: user.username,
        appId: user.app_id,
        age: user.age,
        gender: user.gender,
        rating: parseFloat(rating.toFixed(2)),
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    console.error('Error fetching current user:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
