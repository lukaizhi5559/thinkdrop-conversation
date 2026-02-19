# Conversation Service

MCP service for managing conversation sessions and messages in ThinkDrop AI.

## Overview

- **Port**: 3004
- **Database**: Local DuckDB (`./data/conversation.duckdb`)
- **Auth**: API key via `X-API-Key` header (set `CONVERSATION_API_KEY` in `.env`)
- **Tables**: `conversation_sessions`, `conversation_messages`
- **External dep**: Phi4 service (`http://127.0.0.1:3003`) for embeddings (optional, fails gracefully)

## Actions

### Session Management
- `session.create` - Create new conversation session
- `session.list` - List all sessions
- `session.get` - Get session details
- `session.update` - Update session (title, contextData)
- `session.delete` - Delete session and its messages
- `session.getActive` - Get the currently active session
- `session.switch` - Switch active session

### Message Management
- `message.add` - Add message to session (auto-generates embedding via Phi4)
- `message.list` - List messages in session
- `message.get` - Get specific message
- `message.update` - Update message
- `message.delete` - Delete message
- `message.search` - Semantic search across session messages

## Setup

```bash
cd mcp-services/conversation-service
yarn install
cp .env.example .env   # Edit API keys as needed
```

## Running

```bash
# Development (auto-reload)
yarn dev

# Production
yarn start
```

## Curl Test Commands (Black Box Testing)

Set your API key variable first:
```bash
API_KEY="0ShtCz7JyDnpGdWcGP2br4Jhl4eRA3Kg"
BASE="http://localhost:3004"
```

### Health & Info (no auth)
```bash
curl $BASE/health
curl $BASE/info
```

### Create a session
```bash
curl -s -X POST $BASE/session.create \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "version": "mcp.v1",
    "service": "conversation",
    "action": "session.create",
    "requestId": "test_1",
    "payload": { "title": "Test Session" }
  }' | jq .
```

### List sessions
```bash
curl -s -X POST $BASE/session.list \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "version": "mcp.v1",
    "service": "conversation",
    "action": "session.list",
    "requestId": "test_2",
    "payload": { "limit": 10 }
  }' | jq .
```

### Get a session (replace SESSION_ID)
```bash
curl -s -X POST $BASE/session.get \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "version": "mcp.v1",
    "service": "conversation",
    "action": "session.get",
    "requestId": "test_3",
    "payload": { "sessionId": "SESSION_ID" }
  }' | jq .
```

### Add a message (replace SESSION_ID)
```bash
curl -s -X POST $BASE/message.add \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "version": "mcp.v1",
    "service": "conversation",
    "action": "message.add",
    "requestId": "test_4",
    "payload": {
      "sessionId": "SESSION_ID",
      "text": "Hello, this is a test message",
      "sender": "user"
    }
  }' | jq .
```

### List messages (replace SESSION_ID)
```bash
curl -s -X POST $BASE/message.list \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "version": "mcp.v1",
    "service": "conversation",
    "action": "message.list",
    "requestId": "test_5",
    "payload": { "sessionId": "SESSION_ID", "limit": 20 }
  }' | jq .
```

### Semantic search (replace SESSION_ID, requires Phi4 running)
```bash
curl -s -X POST $BASE/message.search \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "version": "mcp.v1",
    "service": "conversation",
    "action": "message.search",
    "requestId": "test_6",
    "payload": {
      "sessionId": "SESSION_ID",
      "query": "test message",
      "limit": 5
    }
  }' | jq .
```

### Delete a session (replace SESSION_ID)
```bash
curl -s -X POST $BASE/session.delete \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "version": "mcp.v1",
    "service": "conversation",
    "action": "session.delete",
    "requestId": "test_7",
    "payload": { "sessionId": "SESSION_ID" }
  }' | jq .
```
