import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { authenticateToken, socketAuthMiddleware } from './middleware/authMiddleware';
import { register, login, getMe } from './controllers/authController';
import {
  requestConnection,
  respondConnection,
  getConnections,
  getPersistentMessages,
  sendPersistentMessage,
  permanentBlock,
} from './controllers/connectionController';
import { tempBlock, ratePartner, reportUser } from './controllers/anonymousController';
import { uploadTempMedia, uploadPersistentMedia } from './controllers/uploadController';
import { registerChatHandlers } from './sockets/chatHandler';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Core Express Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Logging middleware for development
app.use((req, res, next) => {
  console.log(`[HTTP ${new Date().toISOString()}] ${req.method} ${req.url} - Body: ${JSON.stringify(req.body)}`);
  next();
});

// Create HTTP & Socket.io Server
export const server = http.createServer(app);
export const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 1e7, // 10MB
});

// Socket Authentication Middleware
io.use(socketAuthMiddleware);

// Socket Event Connection Handler
io.on('connection', (socket) => {
  const userId = socket.data.user?.userId;
  console.log(`Socket connected: ${socket.id} (User: ${userId})`);
  if (userId) {
    socket.join(`user:${userId}`);
  }
  registerChatHandlers(io, socket);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth Routes (Zero-Personal-Data)
app.post('/api/auth/register', register);
app.post('/api/auth/login', login);
app.get('/api/auth/me', authenticateToken, getMe);

// Layer 2 Persistent Connections & DM Routes
app.post('/api/connections/request', authenticateToken, requestConnection);
app.post('/api/connections/respond', authenticateToken, respondConnection);
app.get('/api/connections', authenticateToken, getConnections);
app.get('/api/connections/:connectionId/messages', authenticateToken, getPersistentMessages);
app.post('/api/connections/:connectionId/messages', authenticateToken, sendPersistentMessage);
app.post('/api/connections/permanent-block', authenticateToken, permanentBlock);

// Layer 1 & Decoupled Moderation Routes
app.post('/api/anonymous/temp-block', authenticateToken, tempBlock);
app.post('/api/anonymous/rate', authenticateToken, ratePartner);
app.post('/api/anonymous/report', authenticateToken, reportUser);

// Media Upload Routes (Both alias paths for seamless compatibility)
app.post('/api/upload/temp-media', authenticateToken, uploadTempMedia);
app.post('/api/upload/temp', authenticateToken, uploadTempMedia);
app.post('/api/upload/persistent-media', authenticateToken, uploadPersistentMedia);
app.post('/api/upload/persistent', authenticateToken, uploadPersistentMedia);

// Start HTTP & WebSocket Server
server.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`Matchmaker Backend Server running on port ${PORT} (host: 0.0.0.0)`);
  console.log(`Zero-Footprint Anonymous Matchmaker & Decoupled Persistent Chat Ready`);
  console.log(`=======================================================`);
});
