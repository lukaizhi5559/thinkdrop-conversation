/**
 * Session Routes
 * Handles all session-related MCP actions
 */

const express = require('express');
const { validateMCPRequest, createMCPResponse } = require('../middleware/validation.cjs');
const sessionHandlers = require('../handlers/sessionHandlers.cjs');

const router = express.Router();

// All session routes use MCP validation
router.use(validateMCPRequest);

// Session create
router.post('/session.create', async (req, res) => {
  try {
    const { requestId, payload } = req.mcpRequest;
    const result = await sessionHandlers.createSession(payload);
    res.json(createMCPResponse(requestId, 'session.create', true, result));
  } catch (error) {
    res.status(500).json(createMCPResponse(req.mcpRequest.requestId, 'session.create', false, null, error.message));
  }
});

// Session list
router.post('/session.list', async (req, res) => {
  try {
    const { requestId, payload } = req.mcpRequest;
    const result = await sessionHandlers.listSessions(payload);
    res.json(createMCPResponse(requestId, 'session.list', true, result));
  } catch (error) {
    res.status(500).json(createMCPResponse(req.mcpRequest.requestId, 'session.list', false, null, error.message));
  }
});

// Session get
router.post('/session.get', async (req, res) => {
  try {
    const { requestId, payload } = req.mcpRequest;
    const result = await sessionHandlers.getSession(payload);
    res.json(createMCPResponse(requestId, 'session.get', true, result));
  } catch (error) {
    res.status(500).json(createMCPResponse(req.mcpRequest.requestId, 'session.get', false, null, error.message));
  }
});

// Session update
router.post('/session.update', async (req, res) => {
  try {
    const { requestId, payload } = req.mcpRequest;
    const result = await sessionHandlers.updateSession(payload);
    res.json(createMCPResponse(requestId, 'session.update', true, result));
  } catch (error) {
    res.status(500).json(createMCPResponse(req.mcpRequest.requestId, 'session.update', false, null, error.message));
  }
});

// Session delete
router.post('/session.delete', async (req, res) => {
  try {
    const { requestId, payload } = req.mcpRequest;
    const result = await sessionHandlers.deleteSession(payload);
    res.json(createMCPResponse(requestId, 'session.delete', true, result));
  } catch (error) {
    res.status(500).json(createMCPResponse(req.mcpRequest.requestId, 'session.delete', false, null, error.message));
  }
});

// Session switch
router.post('/session.switch', async (req, res) => {
  try {
    const { requestId, payload } = req.mcpRequest;
    const result = await sessionHandlers.switchSession(payload);
    res.json(createMCPResponse(requestId, 'session.switch', true, result));
  } catch (error) {
    res.status(500).json(createMCPResponse(req.mcpRequest.requestId, 'session.switch', false, null, error.message));
  }
});

module.exports = router;
