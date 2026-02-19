/**
 * Session Handlers
 * Business logic for session management
 * Ported from ConversationSessionAgent.cjs
 */

const { query, run } = require('../database/connection.cjs');
const { customAlphabet } = require('nanoid');

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

/**
 * Create a new conversation session
 */
async function createSession(payload) {
  const {
    sessionType = 'user-initiated',
    title = 'New Chat Session',
    contextData = {}
  } = payload;

  const sessionId = `session_${Date.now()}_${nanoid()}`;
  const now = new Date().toISOString();

  try {
    // Set all existing sessions to inactive
    await run(`UPDATE conversation_sessions SET is_active = false WHERE is_active = true`);

    // Insert new session
    await run(
      `INSERT INTO conversation_sessions (
        id, type, title, context_data, is_active, message_count,
        created_at, updated_at, last_activity_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        sessionType,
        title,
        JSON.stringify(contextData),
        true,
        0,
        now,
        now,
        now
      ]
    );

    return {
      sessionId,
      session: {
        id: sessionId,
        type: sessionType,
        title,
        contextData,
        isActive: true,
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now
      }
    };
  } catch (error) {
    console.error('❌ [SESSION] Create failed:', error);
    throw error;
  }
}

/**
 * List all conversation sessions
 */
async function listSessions(payload) {
  const {
    limit = 50,
    offset = 0,
    sortBy = 'last_activity_at',
    sortOrder = 'DESC'
  } = payload;

  try {
    let sql = `SELECT * FROM conversation_sessions`;
    sql += ` ORDER BY ${sortBy} ${sortOrder} LIMIT ? OFFSET ?`;

    const sessions = await query(sql, [limit, offset]);

    // Parse JSON fields and enrich with message data
    const enrichedSessions = await Promise.all(
      sessions.map(async (session) => {
        // Get message count
        const countResult = await query(
          `SELECT COUNT(*) as count FROM conversation_messages WHERE session_id = ?`,
          [session.id]
        );
        const messageCount = countResult[0]?.count || 0;

        // Get last message
        let lastMessage = null;
        let lastMessageTime = null;
        if (messageCount > 0) {
          const lastMsgResult = await query(
            `SELECT content, created_at FROM conversation_messages 
             WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
            [session.id]
          );
          if (lastMsgResult[0]) {
            lastMessage = lastMsgResult[0].content;
            lastMessageTime = lastMsgResult[0].created_at;
          }
        }

        return {
          id: session.id,
          type: session.type,
          title: session.title,
          contextData: JSON.parse(session.context_data || '{}'),
          isActive: session.is_active,
          messageCount: parseInt(messageCount) || 0,
          createdAt: session.created_at,
          updatedAt: session.updated_at,
          lastActivityAt: lastMessageTime || session.last_activity_at || session.created_at,
          lastMessage: lastMessage
        };
      })
    );

    return {
      sessions: enrichedSessions,
      count: enrichedSessions.length,
      totalCount: enrichedSessions.length // TODO: Get actual total count
    };
  } catch (error) {
    console.error('❌ [SESSION] List failed:', error);
    throw error;
  }
}

/**
 * Get a specific session by ID
 */
async function getSession(payload) {
  const { sessionId } = payload;

  if (!sessionId) {
    throw new Error('sessionId is required');
  }

  try {
    const sessions = await query(
      `SELECT * FROM conversation_sessions WHERE id = ?`,
      [sessionId]
    );

    if (sessions.length === 0) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const session = sessions[0];

    // Get message count
    const countResult = await query(
      `SELECT COUNT(*) as count FROM conversation_messages WHERE session_id = ?`,
      [sessionId]
    );
    const messageCount = countResult[0]?.count || 0;

    return {
      session: {
        id: session.id,
        type: session.type,
        title: session.title,
        contextData: JSON.parse(session.context_data || '{}'),
        isActive: session.is_active,
        messageCount: parseInt(messageCount) || 0,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        lastActivityAt: session.last_activity_at
      }
    };
  } catch (error) {
    console.error('❌ [SESSION] Get failed:', error);
    throw error;
  }
}

/**
 * Update a session
 */
async function updateSession(payload) {
  const { sessionId, title, contextData } = payload;

  if (!sessionId) {
    throw new Error('sessionId is required');
  }

  try {
    const updates = [];
    const params = [];

    if (title !== undefined) {
      updates.push('title = ?');
      params.push(title);
    }
    if (contextData !== undefined) {
      updates.push('context_data = ?');
      params.push(JSON.stringify(contextData));
    }

    if (updates.length === 0) {
      throw new Error('No fields to update');
    }

    updates.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(sessionId);

    await run(
      `UPDATE conversation_sessions SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    return { success: true, sessionId };
  } catch (error) {
    console.error('❌ [SESSION] Update failed:', error);
    throw error;
  }
}

/**
 * Delete a session
 */
async function deleteSession(payload) {
  const { sessionId } = payload;

  if (!sessionId) {
    throw new Error('sessionId is required');
  }

  try {
    // Delete messages first
    await run(`DELETE FROM conversation_messages WHERE session_id = ?`, [sessionId]);

    // Delete session
    await run(`DELETE FROM conversation_sessions WHERE id = ?`, [sessionId]);

    return { success: true, sessionId };
  } catch (error) {
    console.error('❌ [SESSION] Delete failed:', error);
    throw error;
  }
}

/**
 * Get active session
 */
async function getActiveSession() {
  try {
    const sessions = await query(`SELECT id FROM conversation_sessions WHERE is_active = true LIMIT 1`);
    
    if (!sessions || sessions.length === 0) {
      return { success: true, sessionId: null };
    }
    
    return { success: true, sessionId: sessions[0].id };
  } catch (error) {
    console.error('❌ [SESSION] Get active failed:', error);
    throw error;
  }
}

/**
 * Switch active session
 */
async function switchSession(payload) {
  const { sessionId } = payload;

  if (!sessionId) {
    throw new Error('sessionId is required');
  }

  try {
    // Set all sessions to inactive
    await run(`UPDATE conversation_sessions SET is_active = false WHERE is_active = true`);

    // Set target session to active
    await run(`UPDATE conversation_sessions SET is_active = true WHERE id = ?`, [sessionId]);

    return { success: true, sessionId };
  } catch (error) {
    console.error('❌ [SESSION] Switch failed:', error);
    throw error;
  }
}

module.exports = {
  createSession,
  listSessions,
  getSession,
  updateSession,
  deleteSession,
  getActiveSession,
  switchSession
};
