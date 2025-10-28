# Conversation Service

MCP service for managing conversation sessions and messages in ThinkDrop AI.

## Overview

- **Port**: 3004
- **Database**: Shared DuckDB (`data/agent_memory.duckdb`)
- **Auth**: API key (`auto-generated-key-conversation`)

## Actions

### Session Management
- `session.create` - Create new conversation session
- `session.list` - List all sessions
- `session.get` - Get session details
- `session.update` - Update session (title, metadata)
- `session.delete` - Delete session
- `session.switch` - Switch active session

### Message Management
- `message.add` - Add message to session
- `message.list` - List messages in session
- `message.get` - Get specific message
- `message.update` - Update message
- `message.delete` - Delete message

## Installation

```bash
cd mcp-services/conversation-service
npm install
```

## Running

```bash
# Development
npm run dev

# Production
npm start
```

## Example Request

```javascript
POST http://localhost:3004/session.list
Headers:
  X-API-Key: auto-generated-key-conversation
  Content-Type: application/json

Body:
{
  "version": "mcp.v1",
  "service": "conversation",
  "action": "session.list",
  "requestId": "req_123",
  "payload": {
    "limit": 50,
    "offset": 0
  }
}
```

## Example Response

```javascript
{
  "version": "mcp.v1",
  "service": "conversation",
  "action": "session.list",
  "requestId": "req_123",
  "success": true,
  "data": {
    "sessions": [
      {
        "id": "session_123",
        "title": "Chat 1",
        "type": "user-initiated",
        "isActive": true,
        "createdAt": "2025-10-22T17:00:00Z"
      }
    ],
    "count": 1
  }
}
```

## Health Check

```bash
curl http://localhost:3004/health
```

## Service Info

```bash
curl http://localhost:3004/info
```
