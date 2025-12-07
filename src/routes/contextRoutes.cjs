/**
 * Context Routes
 * API endpoints for context and entity management
 */

const express = require('express');
const router = express.Router();

function createContextRoutes(contextHandler) {
  // Add context
  router.post('/context.add', async (req, res) => {
    try {
      const { sessionId, contextType, key, value, confidence, sourceMessageId } = req.body.payload;
      
      if (!sessionId || !contextType || !key || !value) {
        return res.status(400).json({
          version: 'mcp.v1',
          status: 'error',
          error: {
            code: 'INVALID_PARAMS',
            message: 'Missing required parameters: sessionId, contextType, key, value'
          }
        });
      }
      
      const result = await contextHandler.addContext(
        sessionId,
        contextType,
        key,
        value,
        confidence,
        sourceMessageId
      );
      
      res.json({
        version: 'mcp.v1',
        service: 'conversation',
        action: 'context.add',
        status: 'ok',
        data: result
      });
    } catch (error) {
      console.error('❌ [ROUTE] context.add failed:', error);
      res.status(500).json({
        version: 'mcp.v1',
        status: 'error',
        error: {
          code: 'CONTEXT_ADD_FAILED',
          message: error.message
        }
      });
    }
  });
  
  // Get context
  router.post('/context.get', async (req, res) => {
    try {
      const { sessionId, contextType } = req.body.payload;
      
      if (!sessionId) {
        return res.status(400).json({
          version: 'mcp.v1',
          status: 'error',
          error: {
            code: 'INVALID_PARAMS',
            message: 'Missing required parameter: sessionId'
          }
        });
      }
      
      const contexts = await contextHandler.getContext(sessionId, contextType);
      
      res.json({
        version: 'mcp.v1',
        service: 'conversation',
        action: 'context.get',
        status: 'ok',
        data: {
          contexts,
          count: contexts.length
        }
      });
    } catch (error) {
      console.error('❌ [ROUTE] context.get failed:', error);
      res.status(500).json({
        version: 'mcp.v1',
        status: 'error',
        error: {
          code: 'CONTEXT_GET_FAILED',
          message: error.message
        }
      });
    }
  });
  
  // Extract context from message
  router.post('/context.extract', async (req, res) => {
    try {
      const { text, sessionId, messageId } = req.body.payload;
      
      if (!text || !sessionId) {
        return res.status(400).json({
          version: 'mcp.v1',
          status: 'error',
          error: {
            code: 'INVALID_PARAMS',
            message: 'Missing required parameters: text, sessionId'
          }
        });
      }
      
      const extraction = await contextHandler.extractAndStore(text, sessionId, messageId);
      
      res.json({
        version: 'mcp.v1',
        service: 'conversation',
        action: 'context.extract',
        status: 'ok',
        data: extraction
      });
    } catch (error) {
      console.error('❌ [ROUTE] context.extract failed:', error);
      res.status(500).json({
        version: 'mcp.v1',
        status: 'error',
        error: {
          code: 'CONTEXT_EXTRACT_FAILED',
          message: error.message
        }
      });
    }
  });
  
  return router;
}

module.exports = { createContextRoutes };
