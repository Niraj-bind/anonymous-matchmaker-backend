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
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const authMiddleware_1 = require("./middleware/authMiddleware");
const authController_1 = require("./controllers/authController");
const connectionController_1 = require("./controllers/connectionController");
const anonymousController_1 = require("./controllers/anonymousController");
const uploadController_1 = require("./controllers/uploadController");
const chatHandler_1 = require("./sockets/chatHandler");
const callHandler_1 = require("./sockets/callHandler");
const matchmaker_1 = require("./sockets/matchmaker");
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 4000;
// Rate Limiters
const authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 30, // Limit each IP to 30 requests per 15 mins for auth
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts, please try again later.' },
});
const apiLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 120, // 120 requests per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down.' },
});
// Core Express Middleware
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
// Sanitized Logging Middleware
app.use((req, res, next) => {
    const isSensitive = req.url.includes('/auth') || req.url.includes('/upload');
    const safeBody = isSensitive ? '[REDACTED]' : JSON.stringify(req.body);
    console.log(`[HTTP ${new Date().toISOString()}] ${req.method} ${req.url} - ${safeBody}`);
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
// Register io on Express app to avoid circular imports
app.set('io', exports.io);
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
    (0, callHandler_1.registerCallHandlers)(exports.io, socket);
});
// Run continuous background matchmaker loop every 2 seconds
const matchmakerInterval = setInterval(async () => {
    try {
        await (0, matchmaker_1.processMatchmakerQueue)(exports.io);
    }
    catch (e) {
        console.error('Error in periodic matchmaker worker:', e);
    }
}, 2000);
// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});
// Apply API Rate Limiter
app.use('/api/', apiLimiter);
// Auth Routes (Zero-Personal-Data)
app.post('/api/auth/register', authLimiter, authController_1.register);
app.post('/api/auth/login', authLimiter, authController_1.login);
app.get('/api/auth/me', authMiddleware_1.authenticateToken, authController_1.getMe);
// Layer 2 Persistent Connections & DM Routes
app.post('/api/connections/request', authMiddleware_1.authenticateToken, connectionController_1.requestConnection);
app.post('/api/connections/respond', authMiddleware_1.authenticateToken, connectionController_1.respondConnection);
app.get('/api/connections', authMiddleware_1.authenticateToken, connectionController_1.getConnections);
app.get('/api/connections/:connectionId/messages', authMiddleware_1.authenticateToken, connectionController_1.getPersistentMessages);
app.post('/api/connections/:connectionId/messages', authMiddleware_1.authenticateToken, connectionController_1.sendPersistentMessage);
app.post('/api/connections/block', authMiddleware_1.authenticateToken, connectionController_1.permanentBlock);
// Layer 1 Ephemeral Anonymous Chat Routes
app.post('/api/anonymous/temp-block', authMiddleware_1.authenticateToken, anonymousController_1.tempBlock);
app.post('/api/anonymous/rate', authMiddleware_1.authenticateToken, anonymousController_1.ratePartner);
app.post('/api/anonymous/report', authMiddleware_1.authenticateToken, anonymousController_1.reportUser);
// Temp & Persistent Media Upload Routes
app.post('/api/upload/temp-media', authMiddleware_1.authenticateToken, uploadController_1.uploadTempMedia);
app.post('/api/upload/persistent-media', authMiddleware_1.authenticateToken, uploadController_1.uploadPersistentMedia);
// WebRTC ICE Servers Configuration Route
const iceServers_1 = require("./config/iceServers");
app.get('/api/calls/ice-servers', authMiddleware_1.authenticateToken, (req, res) => {
    res.status(200).json({ iceServers: (0, iceServers_1.getIceServers)() });
});
// Global Error Handler
app.use((err, req, res, next) => {
    console.error('Unhandled Express Error:', err);
    res.status(500).json({ error: 'Internal server error' });
});
// Graceful shutdown handling for Render
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received. Closing HTTP server and matchmaker loop...');
    clearInterval(matchmakerInterval);
    exports.server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
    });
});
exports.server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
