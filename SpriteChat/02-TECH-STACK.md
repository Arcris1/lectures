# SpriteChat - Tech Stack

## Stack Overview

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Desktop App | Flutter Desktop (Windows) | Main application shell |
| Game/Sprite Engine | Flame | 2D sprite animation, game loop, movement |
| Character Assets | Aseprite + `flame_aseprite` | Sprite sheet creation and loading |
| State Management | Riverpod (code generation) | Reactive state across app |
| Navigation | GoRouter | Screen routing |
| HTTP Client | Dio | REST API communication |
| Backend API | Laravel 12 (PHP 8.2+) | Business logic, auth, message storage |
| Auth | Laravel Sanctum | Token-based authentication |
| WebSocket | Workerman (ws-gateway) | Real-time event broadcasting |
| Message Queue | Redis | Async job processing, pub/sub |
| AI Sentiment | Ollama (llama3.2:3b) | Local LLM for message analysis |
| Database | PostgreSQL | Primary data storage |
| Containerization | Docker Compose | Backend service orchestration |

---

## Frontend: Flutter Desktop

### Why Flutter?

- **Animation-first**: Built-in animation framework + Flame engine = smooth 60fps sprite animation
- **Single codebase**: Windows now, macOS/Linux/mobile later
- **Compiled performance**: Native binary, not web-wrapped like Electron
- **Mature ecosystem**: Riverpod, GoRouter, Dio - proven in production

### Key Dependencies

```yaml
dependencies:
  # Core Framework
  flutter_riverpod: ^2.6.1      # State management
  riverpod_annotation: ^2.6.1   # Code generation annotations
  go_router: ^14.8.1            # Navigation
  dio: ^5.7.0                   # HTTP client

  # Game Engine (Sprite System)
  flame: ^1.22.0                # 2D game engine
  flame_audio: ^2.10.6          # Sound effects
  flame_aseprite: ^0.3.0        # Aseprite sprite sheet loader

  # UI
  google_fonts: ^6.2.1          # Nunito, Quicksand fonts
  flutter_animate: ^4.5.2       # UI micro-interactions

  # WebSocket
  web_socket_channel: ^3.0.2    # Pusher protocol communication

  # Data
  freezed_annotation: ^2.4.4    # Immutable models
  json_annotation: ^4.9.0       # JSON serialization
  shared_preferences: ^2.3.4    # Local key-value storage
  uuid: ^4.5.1                  # Unique identifiers

dev_dependencies:
  riverpod_generator: ^2.6.3    # Riverpod code gen
  build_runner: ^2.4.13         # Code generation runner
  freezed: ^2.5.7               # Immutable model code gen
  json_serializable: ^6.8.0     # JSON code gen
```

---

## Game Engine: Flame

### Why Flame?

The app's core feature is 2D sprite characters running across screens. This requires:

- **Sprite sheet animation** (frame-by-frame with state transitions)
- **Game loop** (update/render cycle for smooth movement)
- **Position/velocity systems** (character movement across screen)
- **Overlay system** (game layer on top of Flutter UI widgets)

Flame provides all of this natively for Flutter.

### Key Flame Concepts Used

| Concept | Class | Usage |
|---------|-------|-------|
| Game container | `FlameGame` | Root game class, manages game loop |
| Sprite animation | `SpriteAnimationComponent` | Animated character with multiple states |
| Sprite sheets | `SpriteSheet` / `AsepriteComponent` | Load frame-by-frame animations |
| Overlays | `GameWidget.overlayBuilderMap` | Flutter UI on top of game |
| Audio | `FlameAudio` | Footsteps, delivery ding, snore sounds |
| Effects | `ParticleSystemComponent` | Sparkles, confetti on delivery |

### Flame + Flutter Integration

The Flame game runs as a transparent overlay on top of the regular Flutter UI:

```
+----------------------------------+
|  Flutter UI (chat, sidebar)      |  <- Regular Flutter widgets
|  +----------------------------+  |
|  |  Flame GameWidget          |  |  <- Transparent game layer
|  |  (characters run here)     |  |
|  +----------------------------+  |
+----------------------------------+
```

Characters animate in the Flame layer while the chat UI remains fully interactive underneath.

---

## Backend: Laravel 12

### Why Laravel?

- Consistent with existing workspace projects
- Sanctum for simple token auth
- Built-in event broadcasting with Pusher driver (compatible with ws-gateway)
- Queue system for async AI processing
- Eloquent ORM for clean data access

### Backend Services

| Service | Purpose |
|---------|---------|
| `MessageService` | Send, store, retrieve messages |
| `SentimentService` | HTTP client to Ollama for AI analysis |
| `RoutingService` | Calculate character delivery path |
| `ResponseService` | Consistent JSON API responses |

---

## WebSocket: Workerman (ws-gateway)

### Reusing Existing Infrastructure

The workspace already has a production-grade WebSocket gateway at `ws-gateway/`:

- **Pusher protocol compatible** - Works with Laravel's broadcasting driver
- **Presence channels** - Track who's online (critical for routing)
- **Private channels** - Secure DM delivery
- **Battle-tested** - Rate limiting, HMAC auth, cluster scaling

### Connection Flow

```
Flutter App
    |
    |-- WS connect to ws-gateway:6001 (Pusher protocol)
    |-- Subscribe to private-user.{id} channel
    |-- Subscribe to presence-online channel
    |
Laravel Backend
    |
    |-- HTTP POST to ws-gateway:6002 (broadcast events)
    |-- Events: message.sent, sentiment.analyzed, message.delivery
```

No new WebSocket server needed - just register a new app in the gateway config.

---

## AI: Ollama (Local LLM)

### Why Local AI?

- **No API costs** - Runs on local machine
- **Privacy** - Messages never leave the network
- **Low latency** - localhost HTTP calls

### Model Choice

| Model | Size | Speed | Use Case |
|-------|------|-------|----------|
| `llama3.2:1b` | ~1.3 GB | <1s | Fastest, good for classification |
| `llama3.2:3b` | ~2 GB | 1-2s | **Recommended** - best balance |
| `phi3:mini` | ~2.3 GB | 1-2s | Alternative lightweight |

### How It Works

1. Message is sent and delivered immediately (no AI blocking)
2. A queued Laravel job calls Ollama asynchronously
3. Ollama classifies: emotion, urgency, speed
4. Result broadcast via WebSocket
5. Flutter updates character animation in real-time

---

## Database: PostgreSQL

### Why PostgreSQL?

- JSON column support for flexible metadata
- Better concurrent write performance than MySQL
- Consistent with several workspace projects

### Core Tables

- `users` - Account info + character skin preference
- `conversations` - Direct or group chat containers
- `conversation_participants` - Many-to-many user-conversation
- `messages` - Content + sentiment analysis results

---

## Sprite Assets: Aseprite

### Why Aseprite?

- Industry standard for pixel art sprite sheets
- Timeline animation with onion skinning
- Direct JSON+PNG export compatible with `flame_aseprite`
- Perfect for chibi/kawaii character creation

### Asset Pipeline

```
Aseprite (create art)
    |
    v
Export as JSON + PNG sprite sheet
    |
    v
Place in assets/sprites/character_name/
    |
    v
Load with flame_aseprite in Flutter
    |
    v
Switch animations by state name: idle, run, sleep, deliver, etc.
```
