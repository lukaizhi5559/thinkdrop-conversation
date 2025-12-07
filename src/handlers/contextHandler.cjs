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
   * Auto-extract and store context from message
   */
  async extractAndStore(text, sessionId, messageId) {
    console.log(`🔍 [CONTEXT] Extracting context from message: "${text.substring(0, 50)}..."`);
    
    try {
      const extraction = await contextExtractor.extract(text, sessionId);
      
      // Store facts only (no entity extraction)
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
      
      console.log(`✅ [CONTEXT] Extracted ${extraction.facts.length} facts, 0 entities`);
      
      return extraction;
    } catch (error) {
      console.error('❌ [CONTEXT] Extraction failed:', error);
      throw error;
    }
  }
}

module.exports = ContextHandler;
