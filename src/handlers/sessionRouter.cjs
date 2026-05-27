/**
 * Session Router Handler
 * Automatically routes messages to existing or new sessions
 * Uses local DistilBert embeddings via @xenova/transformers for topic matching
 */

const { query, run } = require('../database/connection.cjs');
const { customAlphabet } = require('nanoid');
const nlp = require('compromise');

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

// Simplified session routing - StateGraph handles LLM continuity checks
const STALE_DAYS = parseInt(process.env.STALE_DAYS || '30', 10);
const RECENCY_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours for recency checks


  
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
    let activeSession = null;
    try {
      const activeSessions = await query(
        `SELECT id, title, last_activity_at FROM conversation_sessions WHERE is_active = true ORDER BY last_activity_at DESC LIMIT 1`
      );
      if (activeSessions.length > 0) {
        activeSession = activeSessions[0];
        console.log(`🔗 [SESSION-ROUTER] Found active session: "${activeSession.title}" (${activeSession.id})`);
        
        // Update last activity time
        const now = new Date().toISOString();
        await run(
          `UPDATE conversation_sessions SET last_activity_at = ? WHERE id = ?`,
          [now, activeSession.id]
        );
        
        return {
          sessionId: activeSession.id,
          action: 'matched',
          title: activeSession.title,
        };
      }
    } catch (err) {
      console.warn('⚠️ [SESSION-ROUTER] Failed to check active session:', err.message);
    }

    // ── Create new session if no active session exists ──
    const topic = extractTitle(text);
    const title = formatSessionTitle(topic);
    const sessionId = `session_${Date.now()}_${nanoid()}`;
    const now = new Date().toISOString();

    console.log(`🆕 [SESSION-ROUTER] Creating new session: "${title}" (no active session found)`);

    // Create new session (no embedding)
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
  getSessionMessages,
  checkContextContinuity,
  purgeStaleSession,
  startPurgeTimer,
  stopPurgeTimer
};
