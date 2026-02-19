/**
 * Conversation Service - MCP Service for ThinkDrop AI
 * Manages conversation sessions and messages
 * Port: 3004
 */

// Load environment variables from root .env file
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const { initializeDatabase } = require('./database/connection.cjs');
const sessionRoutes = require('./routes/sessions.cjs');
const messageRoutes = require('./routes/messages.cjs');
const { authenticateRequest } = require('./middleware/auth.cjs');

const app = express();
const PORT = process.env.PORT || 3004;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint (no auth required)
app.get('/health', (req, res) => {
  res.json({
    service: 'conversation',
    status: 'healthy',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Service info endpoint (no auth required)
app.get('/info', (req, res) => {
  res.json({
    service: 'conversation',
    version: '1.0.0',
    description: 'Conversation Management Service',
    actions: [
      'session.create',
      'session.list',
      'session.get',
      'session.update',
      'session.delete',
      'session.getActive',
      'session.switch',
      'message.add',
      'message.list',
      'message.get',
      'message.update',
      'message.delete',
      'message.search'
    ]
  });
});

// Apply authentication to all routes below
app.use(authenticateRequest);

// Mount routes
app.use('/', sessionRoutes);
app.use('/', messageRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('❌ [CONVERSATION-SERVICE] Error:', err);
  res.status(500).json({
    version: 'mcp.v1',
    service: 'conversation',
    success: false,
    error: err.message || 'Internal server error'
  });
});

// Initialize database and start server
async function start() {
  try {
    console.log('🚀 [CONVERSATION-SERVICE] Starting...');
    
    await initializeDatabase();
    console.log('✅ [CONVERSATION-SERVICE] Database initialized');
    
    app.listen(PORT, () => {
      console.log(`\n✅ [CONVERSATION-SERVICE] Running on port ${PORT}`);
      console.log('   Endpoints: session.{create,list,get,update,delete,getActive,switch}');
      console.log('   Endpoints: message.{add,list,get,update,delete,search}');
      console.log('   Service:   GET /health, GET /info\n');
    });
  } catch (error) {
    console.error('❌ [CONVERSATION-SERVICE] Failed to start:', error);
    process.exit(1);
  }
}

start();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 [CONVERSATION-SERVICE] Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});
