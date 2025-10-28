/**
 * Message Handlers
 * Business logic for message management
 * Ported from ConversationSessionAgent.cjs
 */

const { query, run, getConnection } = require('../database/connection.cjs');
const { customAlphabet } = require('nanoid');
const ContextHandler = require('./contextHandler.cjs');

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

// Initialize context handler (lazy initialization)
let contextHandler = null;
function getContextHandler() {
  if (!contextHandler) {
    try {
      const db = getConnection();
      contextHandler = new ContextHandler(db);
    } catch (error) {
      console.warn('⚠️ [MESSAGE] Context handler not available:', error.message);
    }
  }
  return contextHandler;
}

/**
 * Add a message to a session
 */
async function addMessage(payload) {
  let { sessionId, text, sender, metadata = {} } = payload;

  // Extract response text properly - handle both string and object formats
  while (typeof text === 'object' && text !== null) {
    if (text.response) {
      text = text.response;
    } else if (text.data && text.data.response) {
      text = text.data.response;
    } else {
      text = JSON.stringify(text);
      break;
    }
  }

  // Ensure we have a plain string
  text = typeof text === 'string' ? text : String(text);

  // Validate required parameters
  if (!sessionId || !text || !sender) {
    throw new Error('Missing required parameters: sessionId, text, and sender are required');
  }

  try {
    // Check for duplicate messages (same text, sender, session within last 5 seconds)
    const recentCutoff = new Date(Date.now() - 5000).toISOString();
    const duplicateCheck = await query(
      `SELECT id FROM conversation_messages 
       WHERE session_id = ? AND content = ? AND role = ? AND created_at > ?
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId, text, sender, recentCutoff]
    );

    if (duplicateCheck.length > 0) {
      console.log('⚠️ [MESSAGE] Duplicate detected, skipping:', duplicateCheck[0].id);
      return {
        messageId: duplicateCheck[0].id,
        isDuplicate: true
      };
    }

    const messageId = `msg_${Date.now()}_${nanoid()}`;
    const timestamp = new Date().toISOString();

    // Insert message
    await run(
      `INSERT INTO conversation_messages (id, session_id, content, role, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [messageId, sessionId, text, sender, timestamp, JSON.stringify(metadata)]
    );

    // Update session message count and last activity
    await run(
      `UPDATE conversation_sessions 
       SET message_count = message_count + 1, 
           updated_at = ?, 
           last_activity_at = ?
       WHERE id = ?`,
      [timestamp, timestamp, sessionId]
    );

    // Auto-extract context if user message
    if (sender === 'user') {
      const handler = getContextHandler();
      if (handler) {
        try {
          await handler.extractAndStore(text, sessionId, messageId);
        } catch (error) {
          console.warn('⚠️ [MESSAGE] Context extraction failed:', error.message);
          // Don't fail the message add if extraction fails
        }
      }
    }

    return {
      messageId,
      message: {
        id: messageId,
        sessionId,
        text,
        sender,
        timestamp,
        metadata
      }
    };
  } catch (error) {
    console.error('❌ [MESSAGE] Add failed:', error);
    throw error;
  }
}

/**
 * List messages in a session
 */
async function listMessages(payload) {
  const {
    sessionId,
    limit = 50,
    offset = 0,
    direction = 'DESC'
  } = payload;

  if (!sessionId) {
    throw new Error('sessionId is required');
  }

  try {
    const messages = await query(
      `SELECT * FROM conversation_messages 
       WHERE session_id = ? 
       ORDER BY created_at ${direction} 
       LIMIT ? OFFSET ?`,
      [sessionId, limit, offset]
    );

    // Get total count
    const countResult = await query(
      `SELECT COUNT(*) as count FROM conversation_messages WHERE session_id = ?`,
      [sessionId]
    );
    const totalCount = countResult[0]?.count || 0;

    // Parse metadata
    const parsedMessages = messages.map(msg => ({
      id: msg.id,
      sessionId: msg.session_id,
      text: msg.content,
      sender: msg.role,
      timestamp: msg.created_at,
      metadata: JSON.parse(msg.metadata || '{}')
    }));

    return {
      messages: parsedMessages,
      sessionId,
      count: parsedMessages.length,
      totalCount: parseInt(totalCount) || 0,
      limit,
      offset
    };
  } catch (error) {
    console.error('❌ [MESSAGE] List failed:', error);
    throw error;
  }
}

/**
 * Get a specific message
 */
async function getMessage(payload) {
  const { messageId } = payload;

  if (!messageId) {
    throw new Error('messageId is required');
  }

  try {
    const messages = await query(
      `SELECT * FROM conversation_messages WHERE id = ?`,
      [messageId]
    );

    if (messages.length === 0) {
      throw new Error(`Message not found: ${messageId}`);
    }

    const msg = messages[0];

    return {
      message: {
        id: msg.id,
        sessionId: msg.session_id,
        text: msg.text,
        sender: msg.sender,
        timestamp: msg.timestamp,
        metadata: JSON.parse(msg.metadata || '{}')
      }
    };
  } catch (error) {
    console.error('❌ [MESSAGE] Get failed:', error);
    throw error;
  }
}

/**
 * Update a message
 */
async function updateMessage(payload) {
  const { messageId, text, metadata } = payload;

  if (!messageId) {
    throw new Error('messageId is required');
  }

  try {
    const updates = [];
    const params = [];

    if (text !== undefined) {
      updates.push('text = ?');
      params.push(text);
    }
    if (metadata !== undefined) {
      updates.push('metadata = ?');
      params.push(JSON.stringify(metadata));
    }

    if (updates.length === 0) {
      throw new Error('No fields to update');
    }

    params.push(messageId);

    await run(
      `UPDATE conversation_messages SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    return { success: true, messageId };
  } catch (error) {
    console.error('❌ [MESSAGE] Update failed:', error);
    throw error;
  }
}

/**
 * Delete a message
 */
async function deleteMessage(payload) {
  const { messageId } = payload;

  if (!messageId) {
    throw new Error('messageId is required');
  }

  try {
    // Get session ID before deleting
    const messages = await query(
      `SELECT session_id FROM conversation_messages WHERE id = ?`,
      [messageId]
    );

    if (messages.length === 0) {
      throw new Error(`Message not found: ${messageId}`);
    }

    const sessionId = messages[0].session_id;

    // Delete message
    await run(`DELETE FROM conversation_messages WHERE id = ?`, [messageId]);

    // Update session message count
    await run(
      `UPDATE conversation_sessions 
       SET message_count = message_count - 1 
       WHERE id = ?`,
      [sessionId]
    );

    return { success: true, messageId };
  } catch (error) {
    console.error('❌ [MESSAGE] Delete failed:', error);
    throw error;
  }
}

module.exports = {
  addMessage,
  listMessages,
  getMessage,
  updateMessage,
  deleteMessage
};
