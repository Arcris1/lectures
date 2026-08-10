# SpriteChat - System Architecture

## High-Level Architecture

```
+-------------------+     +-------------------+     +-------------------+
|   Flutter App     |     |   Flutter App     |     |   Flutter App     |
|   (PC1 - Sender)  |     |   (PC2 - Relay)   |     |   (PC3 - Receiver)|
+--------+----------+     +--------+----------+     +--------+----------+
         |                          |                          |
         |        WebSocket (Pusher Protocol)                  |
         +------------------+------+---------------------------+
                            |
                   +--------v---------+
                   |   ws-gateway     |
                   |   (Workerman)    |
                   |   Port 6001 WS   |
                   |   Port 6002 HTTP  |
                   +--------+---------+
                            |
                   +--------v---------+
                   |   Laravel API    |
                   |   Port 8000      |
                   +--+-----+-----+--+
                      |     |     |
              +-------+  +--+--+  +--------+
              |          |     |           |
        +-----v--+  +---v---+ +---v----+  +--v-----+
        |PostgreSQL| | Redis | | Ollama |  | Queue  |
        |  :5432  | | :6379 | | :11434 |  | Worker |
        +---------+ +-------+ +--------+  +--------+
```

---

## Data Flow: Sending a Message

### Step-by-Step Flow

```
1. PC1 User types message and hits send
        |
        v
2. Flutter -> POST /api/messages
   {conversation_id, content, to_user_id}
        |
        v
3. Laravel MessageController@store
   -> Validate request
   -> MessageService@send()
        |
        +---> Save message to PostgreSQL
        |
        +---> RoutingService@calculatePath()
        |     -> Query presence channel for online users
        |     -> Determine path: [PC1, PC2, PC3]
        |
        +---> Broadcast MessageSent event (immediate)
        |     -> ws-gateway pushes to all path users
        |
        +---> Dispatch AnalyzeSentimentJob (queued)
              -> Redis queue picks it up
              -> SentimentService calls Ollama
              -> Returns {emotion, urgency, speed}
              -> Save to messages table
              -> Broadcast SentimentAnalyzed event
        |
        v
4. ws-gateway broadcasts to subscribed clients:
   - PC2 receives "message.delivery" (role: relay)
   - PC3 receives "message.delivery" (role: destination)
        |
        v
5. Flutter clients receive event:
   - PC2: Spawn character -> run -> idle -> exit (pass-through)
   - PC3: Spawn character -> run -> deliver -> show bubble -> exit
        |
        v
6. (Async) SentimentAnalyzed arrives:
   - Update character animation mid-delivery
   - Change speed, mood, particle effects
```

---

## WebSocket Event Architecture

### Channel Strategy

| Channel | Type | Purpose |
|---------|------|---------|
| `private-user.{id}` | Private | Direct message delivery to specific user |
| `presence-online` | Presence | Track all online users for routing |
| `private-conversation.{id}` | Private | Conversation-specific events (typing, read receipts) |

### Event Types

#### `message.delivery`
Triggered immediately when a message is sent. Contains routing path.

```json
{
  "event": "message.delivery",
  "channel": "private-user.{userId}",
  "data": {
    "message_id": "uuid-here",
    "from_user_id": 1,
    "from_username": "Alice",
    "to_user_id": 3,
    "path": [1, 2, 3],
    "role": "relay",
    "message_preview": "Hey, are you free?",
    "character": {
      "skin": "bunny",
      "mood": "neutral"
    }
  }
}
```

The `role` field tells each client what to do:
- `"sender"` - PC1: show sent confirmation
- `"relay"` - PC2: play pass-through animation
- `"destination"` - PC3: play delivery animation

#### `message.sentiment`
Triggered after AI analysis completes (1-3 seconds after send).

```json
{
  "event": "message.sentiment",
  "channel": "private-user.{userId}",
  "data": {
    "message_id": "uuid-here",
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

#### `client-typing`
Client-side event (whisper) for typing indicators. Doesn't hit the server.

```json
{
  "event": "client-typing",
  "channel": "private-conversation.{id}",
  "data": {
    "user_id": 1,
    "is_typing": true
  }
}
```

---

## Routing System

### How Path Calculation Works

The `RoutingService` determines which screens a character passes through:

```
Input:  from_user_id = 1, to_user_id = 3
Online: [1, 2, 3, 5, 7]

Mode: Direct
Output: [1, 3]
-> Character goes straight to PC3

Mode: Fun (with relays)
Output: [1, 2, 3]
-> Character passes through PC2 first

Mode: Random relay
Output: [1, 5, 3]
-> Character passes through a random online user
```

### Routing Modes

| Mode | Behavior | When Used |
|------|----------|-----------|
| Direct | `[sender, receiver]` | Default for urgent messages |
| Adjacent relay | `[sender, nearby_user, receiver]` | Default for normal messages |
| Multi-relay | `[sender, relay1, relay2, receiver]` | Group chats, fun mode |
| Broadcast | All online users see character | Announcements |

---

## Flutter App Architecture

### Layer Diagram

```
+--------------------------------------------------+
|                   main.dart                       |
|  ProviderScope -> MaterialApp.router -> GoRouter  |
+--------------------------------------------------+
        |                    |
+-------v------+    +-------v-----------------+
|   core/      |    |   features/             |
|              |    |                         |
| config/      |    | auth/                   |
| constants/   |    |   data/ + presentation/ |
| router/      |    |                         |
| services/    |    | chat/                   |
|   websocket  |    |   data/ + presentation/ |
| theme/       |    |                         |
| providers/   |    | contacts/               |
| widgets/     |    |   presentation/         |
+--------------+    |                         |
                    | settings/               |
                    |   presentation/         |
                    +-------------------------+
        |
+-------v-----------------+
|   game/                  |  <- Flame Engine
|                          |
| sprite_overlay_game.dart |
| components/              |
|   messenger_character    |
|   message_bubble         |
|   particle_effects       |
| controllers/             |
|   character_controller   |
|   delivery_controller    |
| models/                  |
|   character_state        |
|   delivery_event         |
| providers/               |
|   game_provider          |
+--------------------------+
```

### State Management Flow

```
WebSocket Event
    |
    v
WebSocket Service (Stream)
    |
    v
Riverpod Provider (websocket_provider)
    |
    +---> Chat Provider (updates message list)
    |
    +---> Game Provider (triggers character animation)
              |
              v
          Flame Game
              |
              v
          Character Component (sprite animation plays)
```

---

## Backend Architecture

### Laravel Service Layer

```
Request -> Controller -> Service -> Model/Repository
                            |
                            +-> Event (broadcast)
                            +-> Job (queued)
```

### Key Services

**MessageService**
```
send(userId, conversationId, content)
  -> validate conversation membership
  -> create message record
  -> calculate delivery path
  -> broadcast MessageSent
  -> dispatch AnalyzeSentimentJob
  -> return message with path data
```

**SentimentService**
```
analyze(messageContent)
  -> HTTP POST to Ollama (localhost:11434)
  -> Parse JSON response
  -> Return {emotion, urgency, speed}
  -> Timeout: 10s (skip if slow, don't block)
```

**RoutingService**
```
calculatePath(fromUser, toUser)
  -> GET online users from ws-gateway presence API
  -> Select routing mode based on message type
  -> Return ordered user ID array
```

---

## Docker Services

### docker-compose.yml Layout

```yaml
services:
  app:        # Laravel PHP-FPM
  nginx:      # Web server (port 8000)
  postgres:   # Database (port 5432)
  redis:      # Cache + Queue (port 6379)
  queue:      # Laravel queue worker
```

The ws-gateway runs separately (already deployed) and Ollama runs as a system service.

---

## Security Considerations

| Concern | Solution |
|---------|----------|
| Auth | Laravel Sanctum tokens (Bearer header) |
| WebSocket auth | HMAC-signed channel subscriptions via Laravel |
| Message privacy | Private channels per user + conversation |
| Rate limiting | ws-gateway built-in (20 conn/10s, 10 events/s) |
| AI privacy | Local Ollama - messages never leave network |
| Input validation | Laravel form requests on all endpoints |
