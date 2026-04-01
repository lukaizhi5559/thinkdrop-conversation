/**
 * Message Handlers
 * Business logic for message management
 * Ported from ConversationSessionAgent.cjs
 */

const { query, run } = require('../database/connection.cjs');
const { customAlphabet } = require('nanoid');
const { storeMessageEmbedding } = require('./semanticSearchHandler.cjs');
const { updateSessionTopicEmbedding } = require('./sessionRouter.cjs');

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

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

    // ✅ STEP 3: Verify message was persisted
    const verification = await query(
      `SELECT id FROM conversation_messages WHERE id = ?`,
      [messageId]
    );
    
    if (verification.length === 0) {
      console.error('❌ [MESSAGE] CRITICAL: Message not found after insert! Retrying...');
      
      // Retry once
      await run(
        `INSERT INTO conversation_messages (id, session_id, content, role, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [messageId, sessionId, text, sender, timestamp, JSON.stringify(metadata)]
      );
      
      // Verify again
      const retryVerification = await query(
        `SELECT id FROM conversation_messages WHERE id = ?`,
        [messageId]
      );
      
      if (retryVerification.length === 0) {
        throw new Error('CRITICAL: Message persistence failed after retry!');
      }
      
      console.log('✅ [MESSAGE] Message persisted after retry');
    } else {
      console.log('✅ [MESSAGE] Message persistence verified:', messageId);
    }

    // Update session message count and last activity
    await run(
      `UPDATE conversation_sessions 
       SET message_count = message_count + 1, 
           updated_at = ?, 
           last_activity_at = ?
       WHERE id = ?`,
      [timestamp, timestamp, sessionId]
    );

    // Generate message embedding asynchronously (non-blocking, uses Phi4)
    storeMessageEmbedding(messageId, text).catch(error => {
      console.warn('⚠️ [MESSAGE] Embedding generation failed:', error.message);
    });

    // Update session topic embedding asynchronously (non-blocking, uses local DistilBert)
    updateSessionTopicEmbedding(sessionId, text).catch(error => {
      console.warn('⚠️ [MESSAGE] Topic embedding update failed:', error.message);
    });

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

/**
 * List messages across all sessions within a date range (cross-session history query)
 */
async function listMessagesByDate(payload) {
  const {
    startDate,
    endDate,
    limit = 50,
    userId
  } = payload;

  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  try {
    const messages = await query(
      `SELECT cm.id, cm.session_id, cm.content, cm.role, cm.created_at, cm.metadata
       FROM conversation_messages cm
       WHERE cm.created_at >= ? AND cm.created_at <= ?
       ORDER BY cm.created_at ASC
       LIMIT ?`,
      [startDate, endDate, limit]
    );

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
      count: parsedMessages.length,
      startDate,
      endDate
    };
  } catch (error) {
    console.error('❌ [MESSAGE] listByDate failed:', error);
    throw error;
  }
}

module.exports = {
  addMessage,
  listMessages,
  listMessagesByDate,
  getMessage,
  updateMessage,
  deleteMessage
};
