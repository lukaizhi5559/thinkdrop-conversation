/**
 * Authentication Middleware
 * Validates API key from request headers
 */

const VALID_API_KEY = process.env.MCP_CONVERSATION_API_KEY || process.env.CONVERSATION_API_KEY || 'auto-generated-key-conversation';

// Debug: Log the API key on startup
console.log('🔑 [CONVERSATION-AUTH] Expected API key:', VALID_API_KEY.substring(0, 10) + '...');

function authenticateRequest(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  
  // Debug: Log incoming requests
  // No key logging — a request path printing credential material (even a
  // prefix) every call leaks into the shared log file.
  
  if (!apiKey) {
    return res.status(401).json({
      version: 'mcp.v1',
      service: 'conversation',
      success: false,
      error: 'Missing API key'
    });
  }
  
  if (apiKey !== VALID_API_KEY) {
    return res.status(403).json({
      version: 'mcp.v1',
      service: 'conversation',
      success: false,
      error: 'Invalid API key'
    });
  }
  
  next();
}

module.exports = { authenticateRequest };
