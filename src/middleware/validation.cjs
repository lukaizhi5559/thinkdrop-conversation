/**
 * Request Validation Middleware
 * Validates MCP request format
 */

function validateMCPRequest(req, res, next) {
  const { version, service, action, payload } = req.body;
  
  if (!version || version !== 'mcp.v1') {
    return res.status(400).json({
      version: 'mcp.v1',
      service: 'conversation',
      success: false,
      error: 'Invalid or missing MCP version'
    });
  }
  
  if (!service || service !== 'conversation') {
    return res.status(400).json({
      version: 'mcp.v1',
      service: 'conversation',
      success: false,
      error: 'Invalid service name'
    });
  }
  
  if (!action) {
    return res.status(400).json({
      version: 'mcp.v1',
      service: 'conversation',
      success: false,
      error: 'Missing action'
    });
  }
  
  // Attach parsed data to request
  req.mcpRequest = {
    version,
    service,
    action,
    requestId: req.body.requestId,
    payload: payload || {}
  };
  
  next();
}

function createMCPResponse(requestId, action, success, data = null, error = null) {
  const response = {
    version: 'mcp.v1',
    service: 'conversation',
    action,
    success
  };
  
  if (requestId) {
    response.requestId = requestId;
  }
  
  if (success && data) {
    response.data = data;
  }
  
  if (!success && error) {
    response.error = error;
  }
  
  return response;
}

module.exports = { validateMCPRequest, createMCPResponse };
