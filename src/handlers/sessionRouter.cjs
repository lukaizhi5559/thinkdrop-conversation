/**
 * Session Router Handler
 * Automatically routes messages to existing or new sessions
 * Uses local DistilBert embeddings via @xenova/transformers for topic matching
 */

const { query, run } = require('../database/connection.cjs');
const { customAlphabet } = require('nanoid');
const { pipeline } = require('@xenova/transformers');
const nlp = require('compromise');

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

// Singleton embedder — loaded once, reused
let embedder = null;
let embedderLoading = false;

// Configurable threshold for session matching
// 0.75 prevents false matches between semantically similar but contextually different prompts
// (e.g. "scan screenshots folder" and "scan thinkdrop-backend" both score ~0.55 on folder/scan topics)
const SIMILARITY_THRESHOLD = parseFloat(process.env.SESSION_SIMILARITY_THRESHOLD || '0.75');
const STALE_DAYS = parseInt(process.env.SESSION_STALE_DAYS || '30', 10);
// Sessions older than this many ms require a higher similarity to match — avoids
// cross-session contamination when the user starts a new unrelated task hours later
const RECENCY_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
const STALE_SESSION_SIMILARITY = parseFloat(process.env.STALE_SESSION_SIMILARITY || '0.90');
// When a hintSessionId is provided (from the prior turn), use a lower similarity bar
// for short messages (≤ 6 words) to treat them as follow-ups.
// The caller (logConversation) passes the previous turn's resolved session as a hint.
const HINT_RECENCY_MS = parseInt(process.env.HINT_RECENCY_MS || String(5 * 60 * 1000), 10); // 5 minutes
const HINT_SHORT_MESSAGE_WORDS = 6; // messages ≤ this many words are treated as potential follow-ups
const HINT_LOW_THRESHOLD = parseFloat(process.env.HINT_LOW_THRESHOLD || '0.10'); // very low — any topical signal suffices

/**
 * Initialize the local DistilBert embedder
 */
async function initEmbedder() {
  if (embedder) return embedder;
  if (embedderLoading) {
    // Wait for in-flight init
    while (embedderLoading) {
      await new Promise(r => setTimeout(r, 100));
    }
    return embedder;
  }

  embedderLoading = true;
  try {
    console.log('🧠 [SESSION-ROUTER] Loading DistilBert embedder...');
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log('✅ [SESSION-ROUTER] DistilBert embedder ready');
    return embedder;
  } catch (error) {
    console.error('❌ [SESSION-ROUTER] Failed to load embedder:', error.message);
    throw error;
  } finally {
    embedderLoading = false;
  }
}

/**
 * Generate embedding for text using local DistilBert
 */
async function generateLocalEmbedding(text) {
  const model = await initEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;

  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) return 0;
  return dot / (normA * normB);
}

/**
 * Extract a short topic title from message text
 * Strategy: strip punctuation → remove stop words → keep content words
 * Then use compromise topics() to find proper nouns to lead the title
 */
function extractTitle(text) {
  // Strip all punctuation first
  const clean = text.replace(/[?!.,;:"'()\[\]{}]/g, '').trim();

  const stopWords = new Set([
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they',
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'am', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'about', 'into', 'through', 'during', 'before', 'after', 'above',
    'below', 'between', 'out', 'off', 'over', 'under', 'again', 'further',
    'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
    'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
    'and', 'but', 'or', 'nor', 'not', 'so', 'very', 'just', 'also',
    'than', 'too', 'some', 'such', 'no', 'only', 'own', 'same',
    'tell', 'let', 'get', 'got', 'set', 'up', 'down', 'if', 'as',
    'im', 'ive', 'dont', 'doesnt', 'its', 'thats', 'love'
  ]);

  // Get content words (no stop words, no single chars)
  const contentWords = clean
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopWords.has(w.toLowerCase()));

  // Try compromise for proper nouns / named entities on the cleaned text
  const doc = nlp(clean);
  const properNouns = doc.match('#ProperNoun+').out('array')
    .map(s => s.replace(/[?!.,;:"'()\[\]{}]/g, '').trim())
    .filter(s => s.length > 1);

  let topic;
  if (properNouns.length > 0) {
    // Lead with proper nouns, fill with remaining content words
    const usedWords = new Set(properNouns.join(' ').toLowerCase().split(/\s+/));
    const extras = contentWords.filter(w => !usedWords.has(w.toLowerCase()));
    const parts = [...properNouns.slice(0, 2)];
    if (extras.length > 0) {
      parts.push(...extras.slice(0, 3 - parts.length));
    }
    topic = parts.join(' ');
  } else {
    // No proper nouns — just use content words
    topic = contentWords.slice(0, 5).join(' ');
  }

  if (!topic || topic.trim().length === 0) {
    topic = clean.split(/\s+/).slice(0, 4).join(' ');
  }

  // Capitalize first letter, trim to reasonable length
  topic = topic.charAt(0).toUpperCase() + topic.slice(1);
  if (topic.length > 50) {
    topic = topic.substring(0, 47) + '...';
  }

  return topic;
}

/**
 * Format title with date
 */
function formatSessionTitle(topic, date = new Date()) {
  const dateStr = date.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric'
  });
  return `${topic} - ${dateStr}`;
}

/**
 * Compute rolling average of two embeddings
 * newAvg = (oldAvg * count + newVec) / (count + 1)
 */
function rollingAverage(existingEmbedding, newEmbedding, messageCount) {
  if (!existingEmbedding || existingEmbedding.length === 0) {
    return newEmbedding;
  }

  const result = new Array(newEmbedding.length);
  for (let i = 0; i < newEmbedding.length; i++) {
    result[i] = (existingEmbedding[i] * messageCount + newEmbedding[i]) / (messageCount + 1);
  }

  // Re-normalize
  let norm = 0;
  for (let i = 0; i < result.length; i++) {
    norm += result[i] * result[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < result.length; i++) {
      result[i] /= norm;
    }
  }

  return result;
}

/**
 * Route a message to the best matching session or create a new one
 * This is the core auto-session logic
 */
async function routeMessage(payload) {
  const { text, threshold = SIMILARITY_THRESHOLD, hintSessionId = null } = payload;

  if (!text) {
    throw new Error('text is required for session routing');
  }

  try {
    console.log(`🔀 [SESSION-ROUTER] Routing: "${text.substring(0, 60)}..."`);

    // 1. Generate embedding for the incoming message
    const messageEmbedding = await generateLocalEmbedding(text);

    // ── Hint session fast-path ───────────────────────────────────────────────
    // When a hintSessionId is provided (from the prior turn's resolvedSessionId),
    // check if the message is a follow-up before running the full embedding search.
    // Two conditions allow the hint to win:
    //   (a) The hint session was active < HINT_RECENCY_MS ago (very recent — same conversation burst)
    //   (b) The message is short (≤ HINT_SHORT_MESSAGE_WORDS words) AND has any topical signal
    //       (similarity ≥ HINT_LOW_THRESHOLD) — catches "check for me now", "do it", "try again"
    // Topic switches are safe: if the session is older AND the message has its own strong topic
    // the normal embedding path below will create a new session as expected.
    if (hintSessionId) {
      try {
        const hintSessions = await query(
          `SELECT id, title, topic_embedding, message_count, last_activity_at
           FROM conversation_sessions WHERE id = ?`,
          [hintSessionId]
        );
        if (hintSessions.length > 0) {
          const hint = hintSessions[0];
          const hintAge = Date.now() - new Date(hint.last_activity_at).getTime();
          const wordCount = text.trim().split(/\s+/).length;
          let hintSimilarity = 0;

          if (hint.topic_embedding) {
            let hintVec;
            try {
              hintVec = typeof hint.topic_embedding === 'string'
                ? JSON.parse(hint.topic_embedding)
                : hint.topic_embedding;
              hintSimilarity = cosineSimilarity(messageEmbedding, hintVec);
            } catch (_) {}
          }

          const isVeryRecent = hintAge < HINT_RECENCY_MS;
          const isShortFollowUp = wordCount <= HINT_SHORT_MESSAGE_WORDS && hintSimilarity >= HINT_LOW_THRESHOLD;

          if (isVeryRecent || isShortFollowUp) {
            console.log(`🔗 [SESSION-ROUTER] Hint match "${hint.title}" (age: ${Math.round(hintAge / 1000)}s, words: ${wordCount}, sim: ${hintSimilarity.toFixed(3)}, veryRecent: ${isVeryRecent})`);

            // Update topic embedding with rolling average
            let existingVec = null;
            if (hint.topic_embedding) {
              try {
                existingVec = typeof hint.topic_embedding === 'string'
                  ? JSON.parse(hint.topic_embedding)
                  : hint.topic_embedding;
              } catch (_) {}
            }
            const updatedEmbedding = rollingAverage(existingVec, messageEmbedding, parseInt(hint.message_count) || 1);
            const topic = hint.title.replace(/ - \d{2}\/\d{2}\/\d{4}$/, '');
            const newTitle = formatSessionTitle(topic);
            const nowIso = new Date().toISOString();

            await run(
              `UPDATE conversation_sessions
               SET topic_embedding = ?, title = ?, updated_at = ?, last_activity_at = ?, is_active = true
               WHERE id = ?`,
              [JSON.stringify(updatedEmbedding), newTitle, nowIso, nowIso, hint.id]
            );
            await run(
              `UPDATE conversation_sessions SET is_active = false WHERE id != ? AND is_active = true`,
              [hint.id]
            );

            return {
              sessionId: hint.id,
              action: 'hint_matched',
              title: newTitle,
              similarity: parseFloat(hintSimilarity.toFixed(3)),
              threshold
            };
          } else {
            console.log(`🔀 [SESSION-ROUTER] Hint rejected (age: ${Math.round(hintAge / 1000)}s > ${HINT_RECENCY_MS / 1000}s, words: ${wordCount}, sim: ${hintSimilarity.toFixed(3)}) — proceeding with embedding search`);
          }
        }
      } catch (hintErr) {
        console.warn('⚠️ [SESSION-ROUTER] Hint lookup failed (non-fatal):', hintErr.message);
      }
    }

    // 2. Get all non-stale sessions that have a topic_embedding
    const staleCutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const sessions = await query(
      `SELECT id, title, topic_embedding, message_count, last_activity_at
       FROM conversation_sessions
       WHERE last_activity_at > ?
       ORDER BY last_activity_at DESC`,
      [staleCutoff]
    );

    // 3. Find the best matching session
    let bestMatch = null;
    let bestSimilarity = 0;
    const now = Date.now();

    for (const session of sessions) {
      if (!session.topic_embedding) continue;

      let topicVec;
      try {
        topicVec = typeof session.topic_embedding === 'string'
          ? JSON.parse(session.topic_embedding)
          : session.topic_embedding;
      } catch (e) {
        continue;
      }

      const similarity = cosineSimilarity(messageEmbedding, topicVec);

      // Apply a higher threshold for sessions that haven't been active recently —
      // a 2-hour-old "scan folder" session shouldn't absorb a new unrelated folder scan.
      const sessionAge = now - new Date(session.last_activity_at).getTime();
      const effectiveThreshold = sessionAge > RECENCY_THRESHOLD_MS ? STALE_SESSION_SIMILARITY : threshold;

      if (similarity > bestSimilarity && similarity >= effectiveThreshold) {
        bestSimilarity = similarity;
        bestMatch = session;
      }
    }

    // 4. Decision: match existing or create new
    if (bestMatch && bestSimilarity >= threshold) {
      // ── MATCH: Continue existing session ──
      console.log(`✅ [SESSION-ROUTER] Matched session "${bestMatch.title}" (similarity: ${bestSimilarity.toFixed(3)})`);

      // Update topic embedding (rolling average)
      let existingVec;
      try {
        existingVec = typeof bestMatch.topic_embedding === 'string'
          ? JSON.parse(bestMatch.topic_embedding)
          : bestMatch.topic_embedding;
      } catch (e) {
        existingVec = null;
      }

      const updatedEmbedding = rollingAverage(
        existingVec,
        messageEmbedding,
        parseInt(bestMatch.message_count) || 1
      );

      // Update the session's title date and topic embedding
      const topic = bestMatch.title.replace(/ - \d{2}\/\d{2}\/\d{4}$/, '');
      const newTitle = formatSessionTitle(topic);
      const now = new Date().toISOString();

      await run(
        `UPDATE conversation_sessions
         SET topic_embedding = ?, title = ?, updated_at = ?, last_activity_at = ?, is_active = true
         WHERE id = ?`,
        [JSON.stringify(updatedEmbedding), newTitle, now, now, bestMatch.id]
      );

      // Deactivate other sessions
      await run(
        `UPDATE conversation_sessions SET is_active = false WHERE id != ? AND is_active = true`,
        [bestMatch.id]
      );

      return {
        sessionId: bestMatch.id,
        action: 'matched',
        title: newTitle,
        similarity: parseFloat(bestSimilarity.toFixed(3)),
        threshold
      };
    } else {
      // ── NO MATCH: Create new session ──
      const topic = extractTitle(text);
      const title = formatSessionTitle(topic);
      const sessionId = `session_${Date.now()}_${nanoid()}`;
      const now = new Date().toISOString();

      console.log(`🆕 [SESSION-ROUTER] Creating new session: "${title}" (best similarity: ${bestSimilarity.toFixed(3)})`);

      // Deactivate all existing sessions
      await run(`UPDATE conversation_sessions SET is_active = false WHERE is_active = true`);

      // Create new session with topic embedding
      await run(
        `INSERT INTO conversation_sessions (
          id, type, title, context_data, is_active, message_count,
          topic_embedding, created_at, updated_at, last_activity_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          'auto',
          title,
          '{}',
          true,
          0,
          JSON.stringify(messageEmbedding),
          now, now, now
        ]
      );

      return {
        sessionId,
        action: 'created',
        title,
        similarity: bestSimilarity > 0 ? parseFloat(bestSimilarity.toFixed(3)) : null,
        threshold
      };
    }
  } catch (error) {
    console.error('❌ [SESSION-ROUTER] Route failed:', error);
    throw error;
  }
}

/**
 * Update a session's topic embedding after a new message is added
 * Called from message.add flow
 */
async function updateSessionTopicEmbedding(sessionId, text) {
  try {
    const messageEmbedding = await generateLocalEmbedding(text);

    // Get current session data
    const sessions = await query(
      `SELECT topic_embedding, message_count FROM conversation_sessions WHERE id = ?`,
      [sessionId]
    );

    if (sessions.length === 0) return;

    const session = sessions[0];
    let existingVec = null;

    if (session.topic_embedding) {
      try {
        existingVec = typeof session.topic_embedding === 'string'
          ? JSON.parse(session.topic_embedding)
          : session.topic_embedding;
      } catch (e) {
        existingVec = null;
      }
    }

    const updatedEmbedding = rollingAverage(
      existingVec,
      messageEmbedding,
      parseInt(session.message_count) || 0
    );

    await run(
      `UPDATE conversation_sessions SET topic_embedding = ? WHERE id = ?`,
      [JSON.stringify(updatedEmbedding), sessionId]
    );

    console.log(`✅ [SESSION-ROUTER] Updated topic embedding for session ${sessionId}`);
  } catch (error) {
    console.warn('⚠️ [SESSION-ROUTER] Failed to update topic embedding:', error.message);
    // Non-fatal — don't break message flow
  }
}

/**
 * Purge stale sessions (no activity for STALE_DAYS days)
 */
async function purgeStaleSession() {
  try {
    const staleCutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Get stale sessions
    const staleSessions = await query(
      `SELECT id, title FROM conversation_sessions WHERE last_activity_at < ?`,
      [staleCutoff]
    );

    if (staleSessions.length === 0) {
      console.log('🧹 [SESSION-ROUTER] No stale sessions to purge');
      return { purged: 0 };
    }

    // Delete messages for stale sessions
    for (const session of staleSessions) {
      await run(`DELETE FROM conversation_messages WHERE session_id = ?`, [session.id]);
      await run(`DELETE FROM conversation_sessions WHERE id = ?`, [session.id]);
      console.log(`🗑️ [SESSION-ROUTER] Purged stale session: "${session.title}" (${session.id})`);
    }

    console.log(`🧹 [SESSION-ROUTER] Purged ${staleSessions.length} stale session(s)`);
    return { purged: staleSessions.length, sessions: staleSessions.map(s => s.id) };
  } catch (error) {
    console.error('❌ [SESSION-ROUTER] Purge failed:', error);
    throw error;
  }
}

/**
 * Start the periodic purge timer (every 30 minutes)
 */
let purgeInterval = null;

function startPurgeTimer() {
  // Run once on startup
  purgeStaleSession().catch(err => {
    console.warn('⚠️ [SESSION-ROUTER] Startup purge failed:', err.message);
  });

  // Then every 30 minutes
  purgeInterval = setInterval(() => {
    purgeStaleSession().catch(err => {
      console.warn('⚠️ [SESSION-ROUTER] Periodic purge failed:', err.message);
    });
  }, 30 * 60 * 1000);

  console.log('🧹 [SESSION-ROUTER] Purge timer started (every 30 min, stale after ' + STALE_DAYS + ' days)');
}

function stopPurgeTimer() {
  if (purgeInterval) {
    clearInterval(purgeInterval);
    purgeInterval = null;
  }
}

module.exports = {
  routeMessage,
  updateSessionTopicEmbedding,
  purgeStaleSession,
  startPurgeTimer,
  stopPurgeTimer,
  initEmbedder
};
