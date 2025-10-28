/**
 * Context Handler
 * Manages session context and entities in the database
 */

const crypto = require('crypto');
const contextExtractor = require('../services/contextExtractor.cjs');

class ContextHandler {
  constructor(db) {
    this.db = db;
  }
  
  /**
   * Add or update context for a session
   */
  async addContext(sessionId, contextType, key, value, confidence = 1.0, sourceMessageId = null) {
    const id = `ctx_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    
    const contextData = JSON.stringify({
      key,
      value,
      confidence,
      sourceMessageId
    });
    
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO session_context (id, session_id, context_type, context_data, created_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [id, sessionId, contextType, contextData],
        function(err) {
          if (err) {
            console.error('❌ [CONTEXT] Failed to add context:', err);
            return reject(err);
          }
          console.log(`✅ [CONTEXT] Added ${contextType}: ${key} = ${value}`);
          resolve({ id, sessionId, contextType, key, value, confidence });
        }
      );
    });
  }
  
  /**
   * Get context for a session
   */
  async getContext(sessionId, contextType = null) {
    return new Promise((resolve, reject) => {
      let query = 'SELECT * FROM session_context WHERE session_id = ?';
      const params = [sessionId];
      
      if (contextType) {
        query += ' AND context_type = ?';
        params.push(contextType);
      }
      
      query += ' ORDER BY created_at DESC';
      
      this.db.all(query, params, (err, rows) => {
        if (err) {
          console.error('❌ [CONTEXT] Failed to get context:', err);
          return reject(err);
        }
        
        // Parse context_data JSON
        const contexts = rows.map(row => {
          try {
            const data = JSON.parse(row.context_data || '{}');
            return {
              id: row.id,
              sessionId: row.session_id,
              contextType: row.context_type,
              ...data,
              createdAt: row.created_at
            };
          } catch (e) {
            console.warn('⚠️ [CONTEXT] Failed to parse context_data:', e);
            return null;
          }
        }).filter(Boolean);
        
        console.log(`✅ [CONTEXT] Retrieved ${contexts.length} context items for session ${sessionId}`);
        resolve(contexts);
      });
    });
  }
  
  /**
   * Add or update entity for a session
   */
  async addEntity(sessionId, entityType, entityValue, metadata = {}) {
    return new Promise((resolve, reject) => {
      // Check if entity already exists
      this.db.get(
        `SELECT * FROM session_entities 
         WHERE session_id = ? AND entity_type = ? AND entity_value = ?`,
        [sessionId, entityType, entityValue],
        (err, existing) => {
          if (err) {
            console.error('❌ [ENTITY] Failed to check entity:', err);
            return reject(err);
          }
          
          if (existing) {
            // Update existing entity
            this.db.run(
              `UPDATE session_entities 
               SET mention_count = mention_count + 1,
                   last_mentioned_at = CURRENT_TIMESTAMP
               WHERE id = ?`,
              [existing.id],
              function(err) {
                if (err) {
                  console.error('❌ [ENTITY] Failed to update entity:', err);
                  return reject(err);
                }
                console.log(`✅ [ENTITY] Updated ${entityType}: ${entityValue} (mentions: ${existing.mention_count + 1})`);
                resolve({ 
                  ...existing, 
                  mention_count: existing.mention_count + 1,
                  last_mentioned_at: new Date().toISOString()
                });
              }
            );
          } else {
            // Insert new entity
            const id = `ent_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
            const metadataStr = JSON.stringify(metadata);
            
            this.db.run(
              `INSERT INTO session_entities 
               (id, session_id, entity_type, entity_value, metadata, first_mentioned_at, last_mentioned_at, mention_count)
               VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)`,
              [id, sessionId, entityType, entityValue, metadataStr],
              function(err) {
                if (err) {
                  console.error('❌ [ENTITY] Failed to add entity:', err);
                  return reject(err);
                }
                console.log(`✅ [ENTITY] Added ${entityType}: ${entityValue}`);
                resolve({ 
                  id, 
                  sessionId, 
                  entity_type: entityType,
                  entity_value: entityValue, 
                  mention_count: 1,
                  metadata: metadataStr
                });
              }
            );
          }
        }
      );
    });
  }
  
  /**
   * Get entities for a session
   */
  async getEntities(sessionId, entityType = null) {
    return new Promise((resolve, reject) => {
      let query = 'SELECT * FROM session_entities WHERE session_id = ?';
      const params = [sessionId];
      
      if (entityType) {
        query += ' AND entity_type = ?';
        params.push(entityType);
      }
      
      query += ' ORDER BY mention_count DESC, last_mentioned_at DESC';
      
      this.db.all(query, params, (err, rows) => {
        if (err) {
          console.error('❌ [ENTITY] Failed to get entities:', err);
          return reject(err);
        }
        
        console.log(`✅ [ENTITY] Retrieved ${rows.length} entities for session ${sessionId}`);
        resolve(rows);
      });
    });
  }
  
  /**
   * Auto-extract and store context from message
   */
  async extractAndStore(text, sessionId, messageId) {
    console.log(`🔍 [CONTEXT] Extracting context from message: "${text.substring(0, 50)}..."`);
    
    try {
      const extraction = await contextExtractor.extract(text, sessionId);
      
      // Store facts
      for (const fact of extraction.facts) {
        try {
          await this.addContext(
            sessionId,
            'fact',
            fact.key,
            fact.value,
            fact.confidence,
            messageId
          );
        } catch (err) {
          console.warn('⚠️ [CONTEXT] Failed to store fact:', err.message);
        }
      }
      
      // Store entities
      for (const entity of extraction.entities) {
        try {
          await this.addEntity(
            sessionId,
            entity.type,
            entity.value,
            { confidence: entity.confidence }
          );
        } catch (err) {
          console.warn('⚠️ [ENTITY] Failed to store entity:', err.message);
        }
      }
      
      console.log(`✅ [CONTEXT] Extracted ${extraction.facts.length} facts, ${extraction.entities.length} entities`);
      
      return extraction;
    } catch (error) {
      console.error('❌ [CONTEXT] Extraction failed:', error);
      throw error;
    }
  }
}

module.exports = ContextHandler;
