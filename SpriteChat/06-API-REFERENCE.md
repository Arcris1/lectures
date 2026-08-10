# SpriteChat - API Reference

## Base URL

```
Development: http://localhost:8000/api
Production:  https://api.spritechat.app/api
```

## Authentication

All endpoints (except register/login) require a Bearer token:

```
Authorization: Bearer {sanctum_token}
```

---

## Auth Endpoints

### POST /auth/register

Create a new user account.

**Request:**
```json
{
  "name": "Alice",
  "email": "alice@example.com",
  "password": "password123",
  "password_confirmation": "password123"
}
```

**Response (201):**
```json
{
  "success": true,
  "message": "Account created successfully",
  "data": {
    "user": {
      "id": 1,
      "name": "Alice",
      "email": "alice@example.com",
      "avatar": null,
      "character_skin": "default",
      "status": "online",
      "created_at": "2026-03-26T10:00:00Z"
    },
    "token": "1|abc123..."
  }
}
```

### POST /auth/login

Authenticate and receive a token.

**Request:**
```json
{
  "email": "alice@example.com",
  "password": "password123"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": {
      "id": 1,
      "name": "Alice",
      "email": "alice@example.com",
      "avatar": null,
      "character_skin": "default",
      "status": "online",
      "created_at": "2026-03-26T10:00:00Z"
    },
    "token": "2|def456..."
  }
}
```

### POST /auth/logout

Revoke current token.

**Response (200):**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

### GET /auth/me

Get current authenticated user.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Alice",
    "email": "alice@example.com",
    "avatar": null,
    "character_skin": "default",
    "status": "online",
    "created_at": "2026-03-26T10:00:00Z"
  }
}
```

---

## User Endpoints

### GET /users

List all users (for contacts/search).

**Query Parameters:**
- `search` (optional) - Filter by name or email
- `status` (optional) - Filter by online/offline/away

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 2,
      "name": "Bob",
      "avatar": null,
      "character_skin": "cat",
      "status": "online"
    },
    {
      "id": 3,
      "name": "Carol",
      "avatar": null,
      "character_skin": "bunny",
      "status": "away"
    }
  ]
}
```

### PUT /users/profile

Update current user profile.

**Request:**
```json
{
  "name": "Alice Updated",
  "character_skin": "fox"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Profile updated",
  "data": {
    "id": 1,
    "name": "Alice Updated",
    "character_skin": "fox"
  }
}
```

---

## Conversation Endpoints

### GET /conversations

List user's conversations with last message.

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid-1",
      "type": "direct",
      "name": null,
      "participants": [
        {"id": 1, "name": "Alice", "character_skin": "default", "status": "online"},
        {"id": 2, "name": "Bob", "character_skin": "cat", "status": "online"}
      ],
      "last_message": {
        "id": "msg-uuid",
        "content": "Hey there!",
        "user_id": 2,
        "created_at": "2026-03-26T14:30:00Z"
      },
      "unread_count": 2,
      "updated_at": "2026-03-26T14:30:00Z"
    }
  ]
}
```

### POST /conversations

Create a new conversation.

**Request:**
```json
{
  "type": "direct",
  "participant_ids": [2]
}
```

For group:
```json
{
  "type": "group",
  "name": "Project Team",
  "participant_ids": [2, 3, 4]
}
```

**Response (201):**
```json
{
  "success": true,
  "message": "Conversation created",
  "data": {
    "id": "uuid-new",
    "type": "direct",
    "name": null,
    "participants": [
      {"id": 1, "name": "Alice"},
      {"id": 2, "name": "Bob"}
    ],
    "created_at": "2026-03-26T15:00:00Z"
  }
}
```

### GET /conversations/{id}

Get conversation details with participants.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "uuid-1",
    "type": "direct",
    "name": null,
    "participants": [
      {"id": 1, "name": "Alice", "character_skin": "default", "status": "online"},
      {"id": 2, "name": "Bob", "character_skin": "cat", "status": "online"}
    ],
    "created_at": "2026-03-26T10:00:00Z"
  }
}
```

---

## Message Endpoints

### GET /conversations/{id}/messages

Get paginated messages for a conversation.

**Query Parameters:**
- `per_page` (optional, default: 50)
- `before` (optional) - Message ID for cursor pagination (load older)

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": "msg-uuid-1",
      "conversation_id": "uuid-1",
      "user_id": 2,
      "user": {
        "id": 2,
        "name": "Bob",
        "character_skin": "cat"
      },
      "content": "Hey! How are you?",
      "type": "text",
      "sentiment_emotion": "happy",
      "sentiment_urgency": "low",
      "read_at": "2026-03-26T14:31:00Z",
      "created_at": "2026-03-26T14:30:00Z"
    },
    {
      "id": "msg-uuid-2",
      "conversation_id": "uuid-1",
      "user_id": 1,
      "user": {
        "id": 1,
        "name": "Alice",
        "character_skin": "default"
      },
      "content": "I'm great! You?",
      "type": "text",
      "sentiment_emotion": "happy",
      "sentiment_urgency": "low",
      "read_at": null,
      "created_at": "2026-03-26T14:31:00Z"
    }
  ],
  "meta": {
    "has_more": true,
    "next_cursor": "msg-uuid-0"
  }
}
```

### POST /conversations/{id}/messages

Send a new message. This triggers the character delivery system.

**Request:**
```json
{
  "content": "Hey, are you free tonight?",
  "type": "text"
}
```

**Response (201):**
```json
{
  "success": true,
  "message": "Message sent",
  "data": {
    "id": "msg-uuid-new",
    "conversation_id": "uuid-1",
    "user_id": 1,
    "content": "Hey, are you free tonight?",
    "type": "text",
    "sentiment_emotion": null,
    "sentiment_urgency": null,
    "delivery_path": [1, 2, 3],
    "created_at": "2026-03-26T15:00:00Z"
  }
}
```

**Side Effects:**
1. `message.delivery` event broadcast to all users in `delivery_path`
2. `AnalyzeSentimentJob` dispatched to queue
3. Once AI completes: `message.sentiment` event broadcast

### POST /conversations/{id}/read

Mark all messages in conversation as read.

**Response (200):**
```json
{
  "success": true,
  "message": "Messages marked as read"
}
```

---

## WebSocket Events (Received by Client)

These events are received via the WebSocket connection (ws-gateway, Pusher protocol).

### message.delivery

Received when a message should trigger character animation.

**Channel:** `private-user.{userId}`

```json
{
  "event": "message.delivery",
  "data": {
    "message_id": "msg-uuid-new",
    "from_user_id": 1,
    "from_username": "Alice",
    "to_user_id": 3,
    "conversation_id": "uuid-1",
    "path": [1, 2, 3],
    "role": "relay",
    "message_preview": "Hey, are you free tonight?",
    "character": {
      "skin": "default",
      "mood": "neutral"
    }
  }
}
```

### message.sentiment

Received after AI analysis completes (1-3 seconds after message.delivery).

**Channel:** `private-user.{userId}`

```json
{
  "event": "message.sentiment",
  "data": {
    "message_id": "msg-uuid-new",
    "sentiment": {
      "emotion": "happy",
      "urgency": "low",
      "speed": "normal"
    },
    "animation_update": {
      "mood": "happy",
      "speed_multiplier": 1.0,
      "particles": "sparkle"
    }
  }
}
```

### message.new

Standard new message event for updating the chat UI (separate from character delivery).

**Channel:** `private-conversation.{conversationId}`

```json
{
  "event": "message.new",
  "data": {
    "id": "msg-uuid-new",
    "conversation_id": "uuid-1",
    "user_id": 1,
    "user": {
      "id": 1,
      "name": "Alice",
      "character_skin": "default"
    },
    "content": "Hey, are you free tonight?",
    "type": "text",
    "created_at": "2026-03-26T15:00:00Z"
  }
}
```

### user.status

User online/offline status change.

**Channel:** `presence-online`

```json
{
  "event": "user.status",
  "data": {
    "user_id": 2,
    "status": "online"
  }
}
```

---

## Error Responses

All errors follow a consistent format:

**Validation Error (422):**
```json
{
  "success": false,
  "message": "Validation failed",
  "errors": {
    "email": ["The email field is required."],
    "password": ["The password must be at least 8 characters."]
  }
}
```

**Unauthorized (401):**
```json
{
  "success": false,
  "message": "Unauthenticated"
}
```

**Not Found (404):**
```json
{
  "success": false,
  "message": "Conversation not found"
}
```

**Server Error (500):**
```json
{
  "success": false,
  "message": "Internal server error"
}
```
