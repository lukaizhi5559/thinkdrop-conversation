/**
 * Database Schema
 * Creates conversation tables for the conversation service
 * Tables: conversation_sessions, conversation_messages
 */

async function createSchema(connection) {
  return new Promise((resolve, reject) => {
    // Create conversation_sessions table (slimmed down)
    const createSessionsSQL = `
      CREATE TABLE IF NOT EXISTS conversation_sessions (
        id TEXT PRIMARY KEY,
        type TEXT DEFAULT 'user-initiated',
        title TEXT,
        context_data TEXT DEFAULT '{}',
        is_active BOOLEAN DEFAULT false,
        message_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    
    // Create conversation_messages table
    const createMessagesSQL = `
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        metadata TEXT,
        embedding DOUBLE[]
      )
    `;
    
    // Create indexes for better query performance
    const createIndexesSQL = `
      CREATE INDEX IF NOT EXISTS idx_messages_session ON conversation_messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON conversation_messages(created_at);
    `;
    
    // Drop legacy tables that are no longer used
    const dropLegacySQL = `
      DROP TABLE IF EXISTS session_message_chunks;
      DROP TABLE IF EXISTS session_entities;
      DROP TABLE IF EXISTS session_context;
    `;
    
    // Execute all statements
    connection.exec(createSessionsSQL, (err) => {
      if (err) {
        console.error('❌ [SCHEMA] Failed to create conversation_sessions:', err);
        return reject(err);
      }
      
      connection.exec(createMessagesSQL, (err) => {
        if (err) {
          console.error('❌ [SCHEMA] Failed to create conversation_messages:', err);
          return reject(err);
        }
        
        connection.exec(createIndexesSQL, (err) => {
          if (err) {
            console.error('❌ [SCHEMA] Failed to create indexes:', err);
            return reject(err);
          }
          
          connection.exec(dropLegacySQL, (err) => {
            if (err) {
              console.warn('⚠️ [SCHEMA] Failed to drop legacy tables:', err.message);
              // Non-fatal — continue anyway
            }
            
            console.log('✅ [SCHEMA] Tables and indexes ready');
            resolve();
          });
        });
      });
    });
  });
}

module.exports = { createSchema };
