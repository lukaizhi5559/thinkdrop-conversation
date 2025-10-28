/**
 * Message Routes
 * Handles all message-related MCP actions
 */

const express = require('express');
const { validateMCPRequest, createMCPResponse } = require('../middleware/validation.cjs');
const messageHandlers = require('../handlers/messageHandlers.cjs');

const router = express.Router();

// All message routes use MCP validation
router.use(validateMCPRequest);

// Message add
router.post('/message.add', async (req, res) => {
  try {
    const { requestId, payload } = req.mcpRequest;
    const result = await messageHandlers.addMessage(payload);
    res.json(createMCPResponse(requestId, 'message.add', true, result));
  } catch (error) {
    res.status(500).json(createMCPResponse(req.mcpRequest.requestId, 'message.add', false, null, error.message));
  }
});

// Message list
router.post('/message.list', async (req, res) => {
  try {
    const { requestId, payload } = req.mcpRequest;
    const result = await messageHandlers.listMessages(payload);
    res.json(createMCPResponse(requestId, 'message.list', true, result));
  } catch (error) {
    res.status(500).json(createMCPResponse(req.mcpRequest.requestId, 'message.list', false, null, error.message));
  }
});

// Message get
router.post('/message.get', async (req, res) => {
  try {
    const { requestId, payload } = req.mcpRequest;
    const result = await messageHandlers.getMessage(payload);
    res.json(createMCPResponse(requestId, 'message.get', true, result));
  } catch (error) {
    res.status(500).json(createMCPResponse(req.mcpRequest.requestId, 'message.get', false, null, error.message));
  }
});

// Message update
router.post('/message.update', async (req, res) => {
  try {
    const { requestId, payload } = req.mcpRequest;
    const result = await messageHandlers.updateMessage(payload);
    res.json(createMCPResponse(requestId, 'message.update', true, result));
  } catch (error) {
    res.status(500).json(createMCPResponse(req.mcpRequest.requestId, 'message.update', false, null, error.message));
  }
});

// Message delete
router.post('/message.delete', async (req, res) => {
  try {
    const { requestId, payload } = req.mcpRequest;
    const result = await messageHandlers.deleteMessage(payload);
    res.json(createMCPResponse(requestId, 'message.delete', true, result));
  } catch (error) {
    res.status(500).json(createMCPResponse(req.mcpRequest.requestId, 'message.delete', false, null, error.message));
  }
});

module.exports = router;
