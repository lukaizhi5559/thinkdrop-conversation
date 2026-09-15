/**
 * Session Router Handler
 * Automatically routes messages to existing or new sessions
 * Uses local DistilBert embeddings via @xenova/transformers for topic matching
 */

const { query, run } = require('../database/connection.cjs');
const { customAlphabet } = require('nanoid');
const nlp = require('compromise');
const { generateEmbedding, cosineSimilarity } = require('./semanticSearchHandler.cjs');

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

// Simplified session routing - StateGraph handles LLM continuity checks
const STALE_DAYS = parseInt(process.env.STALE_DAYS || '30', 10);
const RECENCY_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours for recency checks

// Session rotation: cap + time-based fallbacks (no aggressive topic-change rotation).
// Sessions auto-rotate when they hit MAX_SESSION_MESSAGES (~3-4 months per session).
// This enables the two-tier semantic search (session-level filter → message-level scan).
const MAX_SESSION_MESSAGES = parseInt(process.env.MAX_SESSION_MESSAGES || '2000', 10);
const SESSION_MATCH_THRESHOLD = 0.35;  // semantic re-activation threshold for historical sessions
const SESSION_FILTER_THRESHOLD = 0.15; // two-tier filter: skip sessions below this score

// LLM session summary (generated on rotation, ~4 LLM calls per session)
const SESSION_SUMMARY_SAMPLE_SIZE = 100;  // messages to sample for the LLM
const SESSION_SUMMARY_CHUNK_SIZE = 25;    // messages per LLM call


  
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
 * Route a message to the best matching session or create a new one
 * This is the core auto-session logic
 */
/**
 * Sample messages evenly across a session: first N/4 + last N/4 + middle N/4
 * + random N/4. This gives better topic coverage than just the first N when the
 * session is long (2000 messages) and contains multiple distinct topics.
 *
 * @param {Array<{content:string, created_at:string}>} rows
 * @param {number} targetCount
 * @returns {Array}
 */
function _sampleMessages(rows, targetCount) {
  if (rows.length <= targetCount) return rows;
  const quarter = Math.floor(targetCount / 4);
  const first = rows.slice(0, quarter);
  const last = rows.slice(-quarter);
  const midStart = Math.floor(rows.length / 2) - Math.floor(quarter / 2);
  const middle = rows.slice(midStart, midStart + quarter);
  // Random sample from the remaining rows (avoid duplicates with first/last/middle)
  const used = new Set([...first, ...last, ...middle]);
  const remaining = rows.filter(r => !used.has(r));
  const random = [];
  for (let i = 0; i < quarter && remaining.length > 0; i++) {
    random.push(remaining.splice(Math.floor(Math.random() * remaining.length), 1)[0]);
  }
  return [...first, ...middle, ...last, ...random];
}

/**
 * Call the backend LLM to summarize a chunk of conversation messages into 1-2
 * sentences capturing the topics discussed. Uses the same backend LLM HTTP API
 * as comms-graph (http://localhost:4000/api/llm by default).
 *
 * @param {string} chunkText - concatenated user messages for this chunk
 * @returns {Promise<string|null>} summary text, or null on failure
 */
async function _llmSummarizeChunk(chunkText) {
  const BACKEND_LLM_URL = process.env.BACKEND_LLM_URL || 'http://localhost:4000/api/llm';
  const axios = require('axios');
  const systemPrompt = 'You summarize the topics discussed in a set of user messages. Output 1-2 concise sentences that name each distinct topic. Do not add commentary, headers, or markdown. Example: "Basement redesign with blueprint layout and zoning. Gmail automation for github emails."';
  const userPrompt = `Summarize the topics discussed in these user messages in 1-2 sentences:\n\n${chunkText}`;
  try {
    const resp = await axios.post(
      BACKEND_LLM_URL,
      { messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], maxTokens: 100, temperature: 0.3 },
      { timeout: 8000, headers: { 'Content-Type': 'application/json' } }
    );
    // Backend response shape varies — try common fields.
    const data = resp.data || {};
    const text = data.text || data.content || data.message || (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || (typeof data === 'string' ? data : '');
    return (text || '').trim() || null;
  } catch (err) {
    console.warn('⚠️ [SESSION-ROUTER] LLM chunk summary failed (non-fatal):', err.message);
    return null;
  }
}

/**
 * Build a stable topic representation for a session by sampling up to
 * SESSION_SUMMARY_SAMPLE_SIZE user messages, sending them to the LLM in chunks
 * of SESSION_SUMMARY_CHUNK_SIZE, concatenating the chunk summaries into one
 * topic string, and embedding that summary as the session's `topic_embedding`.
 *
 * The LLM summary captures all distinct topics in a long session (e.g. 2000
 * messages spanning basement redesign, Gmail automation, Amazon orders) far
 * better than concatenating raw messages, which the embedding model truncates
 * at ~256 tokens. Runs silently in the background on session rotation
 * (~3-4 months per session, ~4 LLM calls each).
 *
 * @param {string} sessionId
 */
async function _generateAndStoreSessionSummary(sessionId) {
  if (!sessionId) return;
  try {
    const rows = await query(
      `SELECT content, created_at FROM conversation_messages
       WHERE session_id = ? AND role = 'user'
       ORDER BY created_at ASC`,
      [sessionId]
    );
    if (!rows || rows.length === 0) return;

    // Sample up to SESSION_SUMMARY_SAMPLE_SIZE messages across the whole session.
    const sampled = _sampleMessages(rows, SESSION_SUMMARY_SAMPLE_SIZE);
    if (sampled.length === 0) return;

    // Send to LLM in chunks of SESSION_SUMMARY_CHUNK_SIZE, get a 1-2 sentence summary per chunk.
    const chunkSummaries = [];
    for (let i = 0; i < sampled.length; i += SESSION_SUMMARY_CHUNK_SIZE) {
      const chunk = sampled.slice(i, i + SESSION_SUMMARY_CHUNK_SIZE);
      const chunkText = chunk
        .map(m => (m.content || '').trim().replace(/\s+/g, ' ').slice(0, 200))
        .filter(Boolean)
        .join('\n');
      if (!chunkText) continue;
      const summary = await _llmSummarizeChunk(chunkText);
      if (summary) chunkSummaries.push(summary);
    }

    // Fallback: if every LLM call failed, build a raw-concat topic from the sampled
    // messages (truncated by the embedding model, but better than nothing).
    let topicSummary;
    if (chunkSummaries.length > 0) {
      topicSummary = chunkSummaries.join(' ');
    } else {
      const seen = new Set();
      const fragments = [];
      for (const r of sampled) {
        const frag = (r.content || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        if (!frag) continue;
        const key = frag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        fragments.push(frag);
      }
      topicSummary = fragments.join(' | ');
      if (!topicSummary) return;
    }

    // Embed the summary (~50 tokens, well within the 256-token MiniLM limit).
    const embedding = await generateEmbedding(topicSummary);
    await run(
      `UPDATE conversation_sessions SET topic_embedding = ? WHERE id = ?`,
      [JSON.stringify(embedding), sessionId]
    );

    // Store the summary text in context_data for debugging/display.
    try {
      const ctxRows = await query(
        `SELECT context_data FROM conversation_sessions WHERE id = ?`,
        [sessionId]
      );
      const ctx = JSON.parse((ctxRows[0] && ctxRows[0].context_data) || '{}');
      ctx.topicSummary = topicSummary;
      await run(
        `UPDATE conversation_sessions SET context_data = ? WHERE id = ?`,
        [JSON.stringify(ctx), sessionId]
      );
    } catch (_) { /* context_data update is best-effort */ }

    console.log(`✅ [SESSION-ROUTER] LLM summary embedding stored for ${sessionId} (${sampled.length} msgs sampled, ${chunkSummaries.length} chunks)`);
  } catch (err) {
    console.warn(`⚠️ [SESSION-ROUTER] LLM session summary failed for ${sessionId}:`, err.message);
  }
}

async function routeMessage(payload) {
  const { text, hintSessionId = null, forceNew = false } = payload;

  if (!text) {
    throw new Error('text is required for session routing');
  }

  try {
    console.log(`🔀 [SESSION-ROUTER] Routing: "${text.substring(0, 60)}..."${forceNew ? ' (forced new)' : ''}`);

    // If forceNew is true, skip all matching logic and create new session
    if (forceNew) {
      console.log(`🆕 [SESSION-ROUTER] Force new session requested`);
      const topic = extractTitle(text);
      const title = formatSessionTitle(topic);
      const sessionId = `session_${Date.now()}_${nanoid()}`;
      const now = new Date().toISOString();

      // Deactivate all existing sessions
      await run(`UPDATE conversation_sessions SET is_active = false WHERE is_active = true`);

      // Create new session
      await run(
        `INSERT INTO conversation_sessions (
          id, type, title, context_data, is_active, message_count,
          created_at, updated_at, last_activity_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          'auto',
          title,
          '{}',
          true,
          0,
          now, now, now
        ]
      );

      // Seed the topic_embedding from the first message.
      try {
        const embedding = await generateEmbedding(text);
        await run(
          `UPDATE conversation_sessions SET topic_embedding = ? WHERE id = ?`,
          [JSON.stringify(embedding), sessionId]
        );
        console.log(`✅ [SESSION-ROUTER] Seeded topic embedding for forced-new session ${sessionId}`);
      } catch (embErr) {
        console.warn('⚠️ [SESSION-ROUTER] Failed to seed topic embedding (non-fatal):', embErr.message);
      }

      return {
        sessionId,
        action: 'created',
        title,
      };
    }

    // ── Hint session fast-path ───────────────────────────────────────────────
    // If hintSessionId is provided and very recent, use it directly
    if (hintSessionId) {
      try {
        const hintSessions = await query(
          `SELECT id, title, last_activity_at FROM conversation_sessions WHERE id = ?`,
          [hintSessionId]
        );
        if (hintSessions.length > 0) {
          const hint = hintSessions[0];
          const hintAge = Date.now() - new Date(hint.last_activity_at).getTime();
          
          // Use hint if very recent (within 5 minutes)
          if (hintAge < 5 * 60 * 1000) {
            console.log(`🔗 [SESSION-ROUTER] Hint match "${hint.title}" (age: ${Math.round(hintAge / 1000)}s)`);
            
            const now = new Date().toISOString();
            await run(
              `UPDATE conversation_sessions SET last_activity_at = ?, is_active = true WHERE id = ?`,
              [now, hint.id]
            );
            await run(
              `UPDATE conversation_sessions SET is_active = false WHERE id != ? AND is_active = true`,
              [hint.id]
            );

            return {
              sessionId: hint.id,
              action: 'hint_matched',
              title: hint.title,
            };
          }
        }
      } catch (hintErr) {
        console.warn('⚠️ [SESSION-ROUTER] Hint lookup failed (non-fatal):', hintErr.message);
      }
    }

    // ── Check for existing active session first ──
    // Rotation triggers: (1) message cap (primary), (2) inactivity >2h, (3) age >24h
    let activeSession = null;
    let deactivatedSessionId = null; // captured when we rotate, to exclude from semantic re-activation
    try {
      const activeSessions = await query(
        `SELECT id, title, last_activity_at, created_at, topic_embedding, message_count FROM conversation_sessions WHERE is_active = true ORDER BY last_activity_at DESC LIMIT 1`
      );
      if (activeSessions.length > 0) {
        activeSession = activeSessions[0];
        const nowMs = Date.now();
        const lastActivityMs = new Date(activeSession.last_activity_at).getTime();
        const createdAtMs = new Date(activeSession.created_at).getTime();
        const inactivityMs = nowMs - lastActivityMs;
        const ageMs = nowMs - createdAtMs;

        // Time-based fallback triggers
        const STALE_SESSION_MS = 2 * 60 * 60 * 1000;      // 2 hours inactivity
        const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;   // 24 hours max age
        const staleByTime = inactivityMs > STALE_SESSION_MS || ageMs > MAX_SESSION_AGE_MS;

        // Message-count cap (primary rotation trigger — ~3-4 months per session)
        const staleByCap = (activeSession.message_count || 0) >= MAX_SESSION_MESSAGES;

        if (staleByTime || staleByCap) {
          console.log(`🔄 [SESSION-ROUTER] Rotating session "${activeSession.title}": ${staleByTime ? 'time' : ''} ${staleByCap ? `cap(${activeSession.message_count}>=${MAX_SESSION_MESSAGES})` : ''}`.trim());
          // Generate + store session summary embedding BEFORE deactivating
          await _generateAndStoreSessionSummary(activeSession.id).catch(err =>
            console.warn('⚠️ [SESSION-ROUTER] Session summary failed (non-fatal):', err.message)
          );
          // Deactivate old session
          await run(`UPDATE conversation_sessions SET is_active = false WHERE id = ?`, [activeSession.id]);
          deactivatedSessionId = activeSession.id; // exclude from semantic re-activation below
          activeSession = null; // fall through to semantic re-activation / new session
        } else {
          // Same topic, fresh session → reuse
          console.log(`🔗 [SESSION-ROUTER] Reusing active session: "${activeSession.title}" (${activeSession.id}, ${activeSession.message_count || 0} msgs)`);
          const now = new Date().toISOString();
          await run(`UPDATE conversation_sessions SET last_activity_at = ? WHERE id = ?`, [now, activeSession.id]);
          return { sessionId: activeSession.id, action: 'matched', title: activeSession.title };
        }
      }
    } catch (err) {
      console.warn('⚠️ [SESSION-ROUTER] Failed to check active session:', err.message);
    }

    // ── Semantic re-activation: check if the message matches a prior session ──
    // This handles the Monday-basement/Friday-return scenario: after rotation,
    // if the new message semantically matches a deactivated session, reactivate it.
    // Exclude the just-deactivated session so a topic-change doesn't immediately
    // re-activate the session we just rotated away from.
    try {
      const excludeId = deactivatedSessionId;
      const semanticMatch = await searchSemanticSession(text, SESSION_MATCH_THRESHOLD, excludeId);
      if (semanticMatch) {
        console.log(`🔗 [SESSION-ROUTER] Re-activated session: "${semanticMatch.title}" (score: ${semanticMatch.score.toFixed(3)})`);
        return { sessionId: semanticMatch.sessionId, action: 'semantic_matched', title: semanticMatch.title };
      }
    } catch (err) {
      console.warn('⚠️ [SESSION-ROUTER] Semantic re-activation failed (non-fatal):', err.message);
    }

    // ── Create new session if no active session and no semantic match ──
    const topic = extractTitle(text);
    const title = formatSessionTitle(topic);
    const sessionId = `session_${Date.now()}_${nanoid()}`;
    const now = new Date().toISOString();

    console.log(`🆕 [SESSION-ROUTER] Creating new session: "${title}" (no active session found)`);

    // Deactivate any other active sessions so only one is active at a time.
    await run(`UPDATE conversation_sessions SET is_active = false WHERE is_active = true`);

    // Create new session
    await run(
      `INSERT INTO conversation_sessions (
        id, type, title, context_data, is_active, message_count,
        created_at, updated_at, last_activity_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        'auto',
        title,
        '{}',
        true,
        0,
        now, now, now
      ]
    );

    // Seed the topic_embedding from the first message so the next message's
    // topic-change comparison has something to compare against.
    try {
      const embedding = await generateEmbedding(text);
      await run(
        `UPDATE conversation_sessions SET topic_embedding = ? WHERE id = ?`,
        [JSON.stringify(embedding), sessionId]
      );
      console.log(`✅ [SESSION-ROUTER] Seeded topic embedding for new session ${sessionId}`);
    } catch (embErr) {
      console.warn('⚠️ [SESSION-ROUTER] Failed to seed topic embedding (non-fatal):', embErr.message);
    }

    return {
      sessionId,
      action: 'created',
      title,
    };
  } catch (error) {
    console.error('❌ [SESSION-ROUTER] Route failed:', error);
    throw error;
  }
}


/**
 * Get recent messages from a session for context continuity check
 */
async function getSessionMessages(sessionId, limit = 3) {
  try {
    console.log(`🔍 [SESSION-ROUTER] Getting messages for session: ${sessionId}`);
    const messages = await query(
      `SELECT role, content, created_at as timestamp 
       FROM conversation_messages 
       WHERE session_id = ? 
       ORDER BY created_at DESC 
       LIMIT ?`,
      [sessionId, limit]
    );
    console.log(`🔍 [SESSION-ROUTER] Found ${messages.length} messages for session ${sessionId}`);
    // Map role to sender for compatibility
    return messages.reverse().map(m => ({
      ...m,
      sender: m.role // Map role to sender for the LLM prompt
    }));
  } catch (error) {
    console.warn(`⚠️ [SESSION-ROUTER] Failed to get session messages:`, error.message);
    return [];
  }
}

/**
 * Check if new prompt is a continuation of existing session using LLM
 */
async function checkContextContinuity(newPrompt, sessionTitle, recentMessages) {
  try {
    // Debug: Log what we received
    console.log(`🔍 [SESSION-ROUTER] Continuity check debug:`);
    console.log(`  - Session title: "${sessionTitle}"`);
    console.log(`  - Recent messages count: ${recentMessages.length}`);
    console.log(`  - Recent messages:`, recentMessages.map(m => ({ id: m.id, sender: m.sender, text: m.text?.substring(0, 50) + '...' })));
    
    // If session has no messages, allow it to continue (timing fix)
    // This lets the first prompt populate the session with messages
    if (recentMessages.length === 0) {
      console.log(`📝 [SESSION-ROUTER] Session has no messages - allowing continuation to populate session`);
      return true;
    }
    
    // Check if this prompt is already in the recent messages (timing issue fix)
    const promptExists = recentMessages.some(m => 
      m.sender === 'user' && m.text === newPrompt
    );
    
    if (!promptExists) {
      console.log(`🆕 [SESSION-ROUTER] Current prompt not found in session messages - treating as new context`);
      return false;
    }
    
    // If we get here, the prompt exists in the session, so allow continuation
    console.log(`✅ [SESSION-ROUTER] Prompt found in session - allowing continuation`);
    return true;
  } catch (error) {
    console.error(`❌ [SESSION-ROUTER] Error in continuity check:`, error);
    // On error, create new session to prevent context bleeding
    return false;
  }
}

/**
 * Seed a topic embedding for a session (called per-turn from logConversation).
 *
 * IMPORTANT: This only sets the embedding if none exists yet (first message). It
 * does NOT overwrite an existing topic_embedding on every turn — that would
 * degrade the session topic to just the latest message. The stable, full-session
 * topic embedding is generated by `_generateAndStoreSessionSummary` when the
 * session is deactivated/rotated.
 *
 * Text should be a short summary: intent + answer excerpt
 */
async function updateSessionTopicEmbedding(sessionId, text) {
  if (!sessionId || !text) return;
  try {
    // Only seed if no topic_embedding exists yet — avoid per-turn overwrite.
    const existing = await query(
      `SELECT topic_embedding FROM conversation_sessions WHERE id = ?`,
      [sessionId]
    );
    if (existing.length > 0 && existing[0].topic_embedding) {
      return; // already seeded; summary embedding is set on deactivation
    }

    const embedding = await generateEmbedding(text);
    await run(
      `UPDATE conversation_sessions SET topic_embedding = ? WHERE id = ?`,
      [JSON.stringify(embedding), sessionId]
    );
    console.log(`✅ [SESSION-ROUTER] Seeded topic embedding for session ${sessionId}`);
  } catch (error) {
    console.warn(`⚠️ [SESSION-ROUTER] Failed to seed topic embedding for ${sessionId}:`, error.message);
  }
}

/**
 * Semantic search across all sessions by topic embedding similarity.
 * Returns the best matching session above the threshold, or null.
 */
async function searchSemanticSession(text, threshold = 0.75, excludeSessionId = null) {
  if (!text) return null;
  try {
    const queryEmbedding = await generateEmbedding(text);

    // Fetch all sessions that have a topic_embedding
    const sessions = await query(
      `SELECT id, title, topic_embedding, last_activity_at, context_data
       FROM conversation_sessions
       WHERE topic_embedding IS NOT NULL
       ORDER BY last_activity_at DESC`
    );

    if (sessions.length === 0) return null;

    let bestMatch = null;
    let bestScore = -1;

    for (const session of sessions) {
      // Skip the session we just deactivated (avoid flapping after a topic change).
      if (excludeSessionId && session.id === excludeSessionId) continue;
      try {
        const embedding = typeof session.topic_embedding === 'string'
          ? JSON.parse(session.topic_embedding)
          : session.topic_embedding;

        if (!Array.isArray(embedding) || embedding.length === 0) continue;

        const score = cosineSimilarity(queryEmbedding, embedding);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = { ...session, score };
        }
      } catch (_) {}
    }

    if (bestMatch && bestScore >= threshold) {
      console.log(`🔍 [SESSION-ROUTER] Semantic match: "${bestMatch.title}" (score: ${bestScore.toFixed(3)})`);
      // Reactivate matched session
      const now = new Date().toISOString();
      await run(`UPDATE conversation_sessions SET is_active = false WHERE is_active = true`);
      await run(`UPDATE conversation_sessions SET is_active = true, last_activity_at = ? WHERE id = ?`, [now, bestMatch.id]);
      return {
        sessionId: bestMatch.id,
        title: bestMatch.title,
        score: bestScore,
        action: 'semantic_matched',
        contextData: JSON.parse(bestMatch.context_data || '{}'),
      };
    }

    console.log(`🔍 [SESSION-ROUTER] No semantic match above threshold ${threshold} (best: ${bestScore.toFixed(3)})`);
    return null;
  } catch (error) {
    console.warn(`⚠️ [SESSION-ROUTER] Semantic session search failed:`, error.message);
    return null;
  }
}

/**
 * Purge stale sessions (no activity for STALE_DAYS days)
 *
 * NOTE: Hard purge is DISABLED by default to preserve conversation history for
 * cross-session semantic recall. Old sessions are kept forever (DuckDB handles
 * the storage easily). Set ENABLE_SESSION_PURGE=1 to re-enable the old behavior.
 */
async function purgeStaleSession() {
  if (process.env.ENABLE_SESSION_PURGE !== '1') {
    return { purged: 0, skipped: 'purge disabled (set ENABLE_SESSION_PURGE=1 to enable)' };
  }
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
  getSessionMessages,
  checkContextContinuity,
  updateSessionTopicEmbedding,
  searchSemanticSession,
  purgeStaleSession,
  startPurgeTimer,
  stopPurgeTimer
};
