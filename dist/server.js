"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.io = exports.server = void 0;
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const authMiddleware_1 = require("./middleware/authMiddleware");
const authController_1 = require("./controllers/authController");
const connectionController_1 = require("./controllers/connectionController");
const anonymousController_1 = require("./controllers/anonymousController");
const uploadController_1 = require("./controllers/uploadController");
const chatHandler_1 = require("./sockets/chatHandler");
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 4000;
// Core Express Middleware
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
// Logging middleware for development
app.use((req, res, next) => {
    console.log(`[HTTP ${new Date().toISOString()}] ${req.method} ${req.url} - Body: ${JSON.stringify(req.body)}`);
    next();
});
// Create HTTP & Socket.io Server
exports.server = http_1.default.createServer(app);
exports.io = new socket_io_1.Server(exports.server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
    maxHttpBufferSize: 1e7, // 10MB
});
// Socket Authentication Middleware
exports.io.use(authMiddleware_1.socketAuthMiddleware);
// Socket Event Connection Handler
exports.io.on('connection', (socket) => {
    const userId = socket.data.user?.userId;
    console.log(`Socket connected: ${socket.id} (User: ${userId})`);
    if (userId) {
        socket.join(`user:${userId}`);
    }
    (0, chatHandler_1.registerChatHandlers)(exports.io, socket);
});
// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});
// Auth Routes (Zero-Personal-Data)
app.post('/api/auth/register', authController_1.register);
app.post('/api/auth/login', authController_1.login);
app.get('/api/auth/me', authMiddleware_1.authenticateToken, authController_1.getMe);
// Layer 2 Persistent Connections & DM Routes
app.post('/api/connections/request', authMiddleware_1.authenticateToken, connectionController_1.requestConnection);
app.post('/api/connections/respond', authMiddleware_1.authenticateToken, connectionController_1.respondConnection);
app.get('/api/connections', authMiddleware_1.authenticateToken, connectionController_1.getConnections);
app.get('/api/connections/:connectionId/messages', authMiddleware_1.authenticateToken, connectionController_1.getPersistentMessages);
app.post('/api/connections/:connectionId/messages', authMiddleware_1.authenticateToken, connectionController_1.sendPersistentMessage);
app.post('/api/connections/permanent-block', authMiddleware_1.authenticateToken, connectionController_1.permanentBlock);
// Layer 1 & Decoupled Moderation Routes
app.post('/api/anonymous/temp-block', authMiddleware_1.authenticateToken, anonymousController_1.tempBlock);
app.post('/api/anonymous/rate', authMiddleware_1.authenticateToken, anonymousController_1.ratePartner);
app.post('/api/anonymous/report', authMiddleware_1.authenticateToken, anonymousController_1.reportUser);
// Media Upload Routes (Both alias paths for seamless compatibility)
app.post('/api/upload/temp-media', authMiddleware_1.authenticateToken, uploadController_1.uploadTempMedia);
app.post('/api/upload/temp', authMiddleware_1.authenticateToken, uploadController_1.uploadTempMedia);
app.post('/api/upload/persistent-media', authMiddleware_1.authenticateToken, uploadController_1.uploadPersistentMedia);
app.post('/api/upload/persistent', authMiddleware_1.authenticateToken, uploadController_1.uploadPersistentMedia);
// Start HTTP & WebSocket Server
exports.server.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`Matchmaker Backend Server running on port ${PORT} (host: 0.0.0.0)`);
    console.log(`Zero-Footprint Anonymous Matchmaker & Decoupled Persistent Chat Ready`);
    console.log(`=======================================================`);
});
