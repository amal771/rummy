const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { registerSocketHandlers } = require('./socketHandler');

const app = express();
const server = http.createServer(app);

// Enable trust proxy for Render reverse proxy / SSL termination
app.set('trust proxy', 1);

// Configure Socket.io with optimized transports for cloud environments
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'], // Prefer native WebSockets with polling fallback
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;

// Share the meld rules with the browser so hand badges match server validation
app.get('/shared/rules.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'logic/validator.js'));
});

// Serve static frontend assets from client/
app.use(express.static(path.join(__dirname, '../client')));

// Health check endpoint for Render service zero-downtime health probes
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: Date.now() });
});

// Fallback to index.html for client routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// Register real-time game handlers
registerSocketHandlers(io);

// Graceful shutdown handling (SIGTERM from Render orchestrator)
const shutdown = (signal) => {
  console.log(`Received ${signal}. Closing server connections gracefully...`);
  server.close(() => {
    console.log('HTTP and WebSocket server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Rummy server live on port ${PORT}`);
});
