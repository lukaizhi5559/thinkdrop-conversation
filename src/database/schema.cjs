/**
 * Database Schema
 * Creates conversation tables for the conversation service
 */

async function createSchema(connection) {
  return new Promise((resolve, reject) => {
    // Create conversation_sessions table
    const createSessionsSQL = `
      CREATE TABLE IF NOT EXISTS conversation_sessions (
        id TEXT PRIMARY KEY,
        type TEXT DEFAULT 'user-initiated',
        title TEXT,
        trigger_reason TEXT,
        trigger_confidence DOUBLE DEFAULT 0.0,
        context_data TEXT DEFAULT '{}',
        related_memories TEXT DEFAULT '[]',
        current_activity TEXT DEFAULT '{}',
        is_active BOOLEAN DEFAULT false,
        is_hibernated BOOLEAN DEFAULT false,
        hibernation_data TEXT DEFAULT '{}',
        message_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    
    // Create session_context table (no foreign key constraints - DuckDB limitation)
    const createContextSQL = `
      CREATE TABLE IF NOT EXISTS session_context (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        context_type TEXT,
        context_data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    
    // Create conversation_messages table (no foreign key constraints - DuckDB limitation)
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
    
    // Create session_message_chunks table (no foreign key constraints - DuckDB limitation)
    const createChunksSQL = `
      CREATE TABLE IF NOT EXISTS session_message_chunks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        chunk_index INTEGER,
        chunk_text TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    
    // Create session_entities table for entity tracking
    const createEntitiesSQL = `
      CREATE TABLE IF NOT EXISTS session_entities (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_value TEXT NOT NULL,
        first_mentioned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_mentioned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        mention_count INTEGER DEFAULT 1,
        metadata TEXT DEFAULT '{}'
      )
    `;
    
    // Create indexes for better query performance
    const createIndexesSQL = `
      CREATE INDEX IF NOT EXISTS idx_session_context_session ON session_context(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_context_type ON session_context(context_type);
      CREATE INDEX IF NOT EXISTS idx_session_entities_session ON session_entities(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_entities_type ON session_entities(entity_type);
    `;
    
    // Execute all CREATE TABLE statements
    connection.exec(createSessionsSQL, (err) => {
      if (err) {
        console.error('❌ [SCHEMA] Failed to create conversation_sessions:', err);
        return reject(err);
      }
      
      connection.exec(createContextSQL, (err) => {
        if (err) {
          console.error('❌ [SCHEMA] Failed to create session_context:', err);
          return reject(err);
        }
        
        connection.exec(createMessagesSQL, (err) => {
          if (err) {
            console.error('❌ [SCHEMA] Failed to create conversation_messages:', err);
            return reject(err);
          }
          
          connection.exec(createChunksSQL, (err) => {
            if (err) {
              console.error('❌ [SCHEMA] Failed to create session_message_chunks:', err);
              return reject(err);
            }
            
            connection.exec(createEntitiesSQL, (err) => {
              if (err) {
                console.error('❌ [SCHEMA] Failed to create session_entities:', err);
                return reject(err);
              }
              
              connection.exec(createIndexesSQL, (err) => {
                if (err) {
                  console.error('❌ [SCHEMA] Failed to create indexes:', err);
                  return reject(err);
                }
                
                console.log('✅ [SCHEMA] All conversation tables and indexes created successfully');
                resolve();
              });
            });
          });
        });
      });
    });
  });
}

module.exports = { createSchema };
