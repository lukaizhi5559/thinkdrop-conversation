/**
 * Semantic Search Handler
 * Provides semantic search capabilities for conversation messages
 */

const { query } = require('../database/connection.cjs');
const axios = require('axios');

// PHI4 service endpoint for embeddings
const PHI4_ENDPOINT = process.env.PHI4_ENDPOINT || 'http://127.0.0.1:3003';
const PHI4_API_KEY = process.env.PHI4_API_KEY;

/**
 * Generate embedding for a text using phi4 service
 */
async function generateEmbedding(text) {
  try {
    const response = await axios.post(
      `${PHI4_ENDPOINT}/embedding.generate`,
      {
        version: 'mcp.v1',
        service: 'phi4',
        action: 'embedding.generate',
        requestId: `req_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        payload: {
          text,
          options: {
            normalize: true,
            pooling: 'mean'
          }
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': PHI4_API_KEY
        }
      }
    );

    return response.data.data.embedding;
  } catch (error) {
    console.error('❌ [SEMANTIC] Embedding generation failed:', error.message);
    throw new Error(`Failed to generate embedding: ${error.message}`);
  }
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(vecA, vecB) {
  if (vecA.length !== vecB.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (normA * normB);
}

/**
 * Search messages semantically using embeddings
 */
async function searchMessages(payload) {
  const {
    sessionId,
    query: searchQuery,
    limit = 5,
    minSimilarity = 0.5,
    includeRecent = 3 // Always include N most recent messages
  } = payload;

  if (!sessionId || !searchQuery) {
    throw new Error('sessionId and query are required');
  }

  try {
    console.log(`🔍 [SEMANTIC] Searching messages for: "${searchQuery}"`);

    // Generate embedding for the search query
    const queryEmbedding = await generateEmbedding(searchQuery);

    // Get all messages from the session
    const messages = await query(
      `SELECT id, session_id, content, role, created_at, metadata, embedding 
       FROM conversation_messages 
       WHERE session_id = ? 
       ORDER BY created_at DESC`,
      [sessionId]
    );

    if (messages.length === 0) {
      return {
        messages: [],
        count: 0,
        searchQuery,
        method: 'semantic'
      };
    }

    // Calculate similarity scores for messages with embeddings
    const scoredMessages = messages
      .map(msg => {
        // Parse embedding if it exists
        let embedding = null;
        if (msg.embedding) {
          try {
            embedding = typeof msg.embedding === 'string' 
              ? JSON.parse(msg.embedding) 
              : msg.embedding;
          } catch (e) {
            console.warn(`⚠️ [SEMANTIC] Failed to parse embedding for message ${msg.id}`);
          }
        }

        // Calculate similarity if embedding exists
        const similarity = embedding 
          ? cosineSimilarity(queryEmbedding, embedding)
          : 0;

        return {
          id: msg.id,
          sessionId: msg.session_id,
          text: msg.content,
          sender: msg.role,
          timestamp: msg.created_at,
          metadata: JSON.parse(msg.metadata || '{}'),
          similarity,
          hasEmbedding: !!embedding
        };
      });

    // Separate recent messages (always include) and semantic matches
    const recentMessages = scoredMessages.slice(0, includeRecent);
    const semanticMatches = scoredMessages
      .slice(includeRecent) // Skip recent messages to avoid duplicates
      .filter(msg => msg.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit - includeRecent);

    // Combine: recent messages + semantic matches
    const combinedMessages = [
      ...recentMessages.map(msg => ({ ...msg, reason: 'recent' })),
      ...semanticMatches.map(msg => ({ ...msg, reason: 'semantic' }))
    ];

    console.log(`✅ [SEMANTIC] Found ${combinedMessages.length} messages (${recentMessages.length} recent, ${semanticMatches.length} semantic)`);

    return {
      messages: combinedMessages,
      count: combinedMessages.length,
      searchQuery,
      method: 'semantic',
      stats: {
        totalMessages: messages.length,
        recentCount: recentMessages.length,
        semanticCount: semanticMatches.length,
        messagesWithEmbeddings: scoredMessages.filter(m => m.hasEmbedding).length
      }
    };
  } catch (error) {
    console.error('❌ [SEMANTIC] Search failed:', error);
    throw error;
  }
}

/**
 * Store embedding for a message
 */
async function storeMessageEmbedding(messageId, text) {
  try {
    const embedding = await generateEmbedding(text);
    
    const { run } = require('../database/connection.cjs');
    await run(
      `UPDATE conversation_messages SET embedding = ? WHERE id = ?`,
      [JSON.stringify(embedding), messageId]
    );

    console.log(`✅ [SEMANTIC] Stored embedding for message ${messageId}`);
    return { success: true, messageId };
  } catch (error) {
    console.error('❌ [SEMANTIC] Failed to store embedding:', error);
    throw error;
  }
}

module.exports = {
  searchMessages,
  storeMessageEmbedding,
  generateEmbedding
};
