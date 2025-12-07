/**
 * Conversation Service - MCP Service for ThinkDrop AI
 * Manages conversation sessions and messages
 * Port: 3004
 */

// Load environment variables from root .env file
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const { initializeDatabase, getConnection } = require('./database/connection.cjs');
const sessionRoutes = require('./routes/sessions.cjs');
const messageRoutes = require('./routes/messages.cjs');
const { createContextRoutes } = require('./routes/contextRoutes.cjs');
const ContextHandler = require('./handlers/contextHandler.cjs');
const { authenticateRequest } = require('./middleware/auth.cjs');
const { exec } = require('child_process');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3004;

// Backup function
function backupDatabase() {
  const backupScript = path.join(__dirname, '../../../scripts/backup-conversation-db.sh');
  
  exec(backupScript, (error, stdout, stderr) => {
    if (error) {
      console.error('❌ [BACKUP] Failed to create backup:', error.message);
      return;
    }
    if (stderr) {
      console.warn('⚠️  [BACKUP] Backup warning:', stderr);
    }
    console.log(stdout);
  });
}

// Schedule periodic backups every 5 minutes
const BACKUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
let backupInterval = null;

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
      'session.switch',
      'message.add',
      'message.list',
      'message.get',
      'message.update',
      'message.delete',
      'context.add',
      'context.get',
      'context.extract'
    ]
  });
});

// Apply authentication to all routes below
app.use(authenticateRequest);

// Mount routes (context routes will be added after DB initialization)
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
    
    // Initialize database
    await initializeDatabase();
    console.log('✅ [CONVERSATION-SERVICE] Database initialized');
    
    // Initialize context handler and routes AFTER database is ready
    try {
      const db = getConnection();
      const contextHandler = new ContextHandler(db);
      const contextRoutes = createContextRoutes(contextHandler);
      app.use('/', contextRoutes);
      console.log('✅ [CONVERSATION-SERVICE] Context handler initialized');
    } catch (error) {
      console.error('❌ [CONVERSATION-SERVICE] Failed to initialize context handler:', error);
    }
    
    // Start server
    app.listen(PORT, () => {
      console.log('\n╔═══════════════════════════════════════════════════════╗');
      console.log('║   ThinkDrop Conversation Service                      ║');
      console.log('║   Version: 1.0.0                                      ║');
      console.log(`║   Port: ${PORT}                                          ║`);
      console.log('║   Environment: development                            ║');
      console.log('║   MCP Protocol: v1                                    ║');
      console.log('╚═══════════════════════════════════════════════════════╝\n');
      
      // Start periodic backups
      console.log('💾 [BACKUP] Starting periodic backups (every 5 minutes)...');
      backupInterval = setInterval(backupDatabase, BACKUP_INTERVAL);
      
      // Create initial backup
      console.log('💾 [BACKUP] Creating initial backup...');
      backupDatabase();
      
      console.log('Available endpoints:');
      console.log('  Session Management:');
      console.log('    - POST /session.create       (Create new session)');
      console.log('    - POST /session.list         (List all sessions)');
      console.log('    - POST /session.get          (Get session details)');
      console.log('    - POST /session.update       (Update session)');
      console.log('    - POST /session.delete       (Delete session)');
      console.log('    - POST /session.switch       (Switch active session)');
      console.log('  Message Management:');
      console.log('    - POST /message.add          (Add message to session)');
      console.log('    - POST /message.list         (List messages in session)');
      console.log('    - POST /message.get          (Get message details)');
      console.log('    - POST /message.update       (Update message)');
      console.log('    - POST /message.delete       (Delete message)');
      console.log('  Context Management:');
      console.log('    - POST /context.add          (Add session context)');
      console.log('    - POST /context.get          (Get session context)');
      console.log('    - POST /context.extract      (Extract context from text)');
      console.log('  Service Info:');
      console.log('    - GET  /health               (Health check)');
      console.log('    - GET  /info                 (Service capabilities)\n');
    });
  } catch (error) {
    console.error('❌ [CONVERSATION-SERVICE] Failed to start:', error);
    process.exit(1);
  }
}

start();

// Graceful shutdown with final backup
process.on('SIGINT', async () => {
  console.log('\n🛑 [CONVERSATION-SERVICE] Shutting down gracefully...');
  
  // Stop periodic backups
  if (backupInterval) {
    clearInterval(backupInterval);
    console.log('✅ [BACKUP] Stopped periodic backups');
  }
  
  // Create final backup before shutdown
  console.log('💾 [BACKUP] Creating final backup before shutdown...');
  backupDatabase();
  
  // Wait a bit for backup to complete
  setTimeout(() => {
    console.log('👋 [CONVERSATION-SERVICE] Goodbye!');
    process.exit(0);
  }, 2000);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 [CONVERSATION-SERVICE] Received SIGTERM, shutting down...');
  
  // Stop periodic backups
  if (backupInterval) {
    clearInterval(backupInterval);
  }
  
  // Create final backup
  backupDatabase();
  
  setTimeout(() => {
    process.exit(0);
  }, 2000);
});
