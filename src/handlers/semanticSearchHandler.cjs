/**
 * Semantic Search Handler
 * Provides semantic search capabilities for conversation messages
 */

const { query } = require('../database/connection.cjs');
const axios = require('axios');

// PHI4 service endpoint for embeddings
const PHI4_ENDPOINT = process.env.PHI4_ENDPOINT || 'http://127.0.0.1:3009';
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
          'Authorization': `Bearer ${PHI4_API_KEY}`
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
 * Score a set of message rows against a query embedding and return the top
 * semantic matches above `minSimilarity`. Used internally by both the
 * single-session and cross-session search paths.
 *
 * @param {Array} messages - raw rows from conversation_messages
 * @param {number[]} queryEmbedding
 * @param {number} minSimilarity
 * @param {number} limit
 * @param {string} [sessionTitle] - optional label for logging
 * @returns {Array} scored matches sorted by similarity DESC
 */
function _scoreAndFilterMessages(messages, queryEmbedding, minSimilarity, limit, sessionTitle) {
  const scored = messages
    .map(msg => {
      let embedding = null;
      if (msg.embedding) {
        try {
          embedding = typeof msg.embedding === 'string'
            ? JSON.parse(msg.embedding)
            : msg.embedding;
        } catch (e) { /* ignore parse errors */ }
      }
      const similarity = embedding ? cosineSimilarity(queryEmbedding, embedding) : 0;
      return {
        id: msg.id,
        sessionId: msg.session_id,
        text: msg.content,
        sender: msg.role,
        timestamp: msg.created_at,
        metadata: JSON.parse(msg.metadata || '{}'),
        similarity,
        hasEmbedding: !!embedding,
      };
    })
    .filter(msg => msg.hasEmbedding && msg.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
  if (sessionTitle) {
    console.log(`   └─ [SEMANTIC] "${sessionTitle}": ${scored.length} matches (scanned ${messages.length})`);
  }
  return scored;
}

/**
 * Search messages semantically using embeddings.
 *
 * Two modes:
 *  - Single-session (default): searches within `sessionId`. Always includes the
 *    `includeRecent` most recent messages plus semantic matches from older turns.
 *  - Cross-session (`searchAllSessions: true`): two-tier search. Tier 1 compares
 *    the query embedding against each session's `topic_embedding` and skips
 *    sessions below `sessionFilterThreshold`. Tier 2 runs a full message-level
 *    scan only on sessions that passed the filter. This keeps retrieval fast even
 *    after years of usage (many sessions × 2000 messages each).
 *
 * `maxScan` caps the number of rows scanned per session (default 5000) for
 * future-proofing against very large sessions.
 */
async function searchMessages(payload) {
  const {
    sessionId,
    query: searchQuery,
    limit = 5,
    minSimilarity = 0.5,
    includeRecent = 3, // Always include N most recent messages (single-session mode)
    searchAllSessions = false,
    sessionFilterThreshold = 0.15, // two-tier filter: skip sessions below this score
    maxScan = parseInt(process.env.SEMANTIC_MAX_SCAN || '5000', 10),
  } = payload;

  if (!searchQuery) {
    throw new Error('query is required');
  }
  if (!searchAllSessions && !sessionId) {
    throw new Error('sessionId is required (or set searchAllSessions=true)');
  }

  try {
    console.log(`🔍 [SEMANTIC] Searching messages for: "${searchQuery}" ${searchAllSessions ? '(cross-session)' : ''}`);

    // Generate embedding for the search query
    const queryEmbedding = await generateEmbedding(searchQuery);

    // ── Cross-session two-tier search ──────────────────────────────────────
    if (searchAllSessions) {
      // Tier 1: Compare query embedding vs each session's topic_embedding.
      // Always include the current session (if provided) regardless of score.
      const sessions = await query(
        `SELECT id, title, topic_embedding FROM conversation_sessions
         WHERE topic_embedding IS NOT NULL
         ORDER BY last_activity_at DESC`
      );

      const sessionsToScan = [];
      if (sessionId) {
        sessionsToScan.push({ id: sessionId, title: 'current' });
      }
      let skipped = 0;
      for (const s of sessions) {
        if (s.id === sessionId) continue;
        let emb = null;
        try {
          emb = typeof s.topic_embedding === 'string'
            ? JSON.parse(s.topic_embedding)
            : s.topic_embedding;
        } catch (_) { /* ignore */ }
        if (!Array.isArray(emb) || emb.length === 0) continue;
        const score = cosineSimilarity(queryEmbedding, emb);
        if (score >= sessionFilterThreshold) {
          sessionsToScan.push({ id: s.id, title: s.title || s.id });
        } else {
          skipped++;
        }
      }
      console.log(`🔍 [SEMANTIC] Tier 1: scanning ${sessionsToScan.length} sessions (skipped ${skipped} below ${sessionFilterThreshold})`);

      // Tier 2: Full message scan only on sessions that passed tier 1.
      let allMatches = [];
      for (const s of sessionsToScan) {
        const rows = await query(
          `SELECT id, session_id, content, role, created_at, metadata, embedding
           FROM conversation_messages
           WHERE session_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
          [s.id, maxScan]
        );
        const matches = _scoreAndFilterMessages(rows, queryEmbedding, minSimilarity, limit, s.title);
        allMatches = allMatches.concat(matches.map(m => ({ ...m, sessionTitle: s.title })));
      }

      // Sort all matches by similarity and take the top `limit`.
      allMatches.sort((a, b) => b.similarity - a.similarity);
      const top = allMatches.slice(0, limit).map(m => ({ ...m, reason: 'semantic' }));

      console.log(`✅ [SEMANTIC] Cross-session: ${top.length} matches from ${sessionsToScan.length} sessions`);

      return {
        messages: top,
        count: top.length,
        searchQuery,
        method: 'semantic-cross-session',
        stats: {
          sessionsScanned: sessionsToScan.length,
          sessionsSkipped: skipped,
          totalMatches: allMatches.length,
        },
      };
    }

    // ── Single-session search (existing behavior) ──────────────────────────
    const messages = await query(
      `SELECT id, session_id, content, role, created_at, metadata, embedding
       FROM conversation_messages
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [sessionId, maxScan]
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
  generateEmbedding,
  cosineSimilarity
};
