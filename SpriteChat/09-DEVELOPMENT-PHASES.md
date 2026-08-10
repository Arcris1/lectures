# SpriteChat - Development Phases

## Phase Overview

| Phase | Focus | Duration | Deliverable |
|-------|-------|----------|-------------|
| **Phase 1** | Foundation | Week 1-2 | Working chat app with cute UI |
| **Phase 2** | Sprite System | Week 3-4 | Characters delivering messages |
| **Phase 3** | AI Integration | Week 5-6 | Sentiment-driven character behavior |
| **Phase 4** | Polish & Personality | Week 7-8 | Polished, delightful experience |

---

## Phase 1: Foundation

**Goal**: A functional messaging app with real-time WebSocket communication and kawaii UI design. No sprite characters yet.

### Backend Tasks

- [ ] Create Laravel 12 project with Docker Compose
  - PHP 8.2-FPM + Nginx
  - PostgreSQL 16
  - Redis 7
  - Queue worker container
- [ ] Configure Laravel Sanctum for token auth
- [ ] Database migrations (users, conversations, conversation_participants, messages)
- [ ] Models with relationships
  - User hasMany Messages, belongsToMany Conversations
  - Conversation hasMany Messages, belongsToMany Users
  - Message belongsTo User, belongsTo Conversation
- [ ] ResponseService for consistent JSON API responses
- [ ] AuthController (register, login, logout, me)
- [ ] UserController (index with search, profile update)
- [ ] ConversationController (index, store, show)
- [ ] MessageController (index with cursor pagination, store, mark read)
- [ ] Register new app in ws-gateway config
- [ ] Configure Laravel broadcasting with Workerman/Pusher driver
- [ ] MessageSent broadcast event
- [ ] Channel authorization (private-user.{id}, private-conversation.{id})
- [ ] Form request validation classes
- [ ] API route definitions

### Frontend Tasks

- [ ] Create Flutter desktop project (`flutter create --platforms=windows`)
- [ ] Add dependencies (Riverpod, GoRouter, Dio, Flame, etc.)
- [ ] Kawaii theme system
  - AppColors (pastel palette)
  - AppTypography (Nunito, Quicksand)
  - AppTheme (ThemeData with rounded shapes, soft shadows)
- [ ] Core reusable widgets
  - CuteButton (pill shape, bouncy animation)
  - CuteCard (rounded, soft shadow)
  - CuteTextField (pill input)
  - AvatarWidget (circular with status dot)
- [ ] App configuration (API base URL, WS URL)
- [ ] Dio HTTP client with auth interceptor
- [ ] GoRouter setup (auth guard, routes)
- [ ] Auth screens
  - Login screen (cute design)
  - Register screen (cute design)
  - Auth provider (token storage, login/register/logout)
- [ ] WebSocket service (adapt from CoffeeFinder)
  - Pusher protocol handler
  - Exponential backoff reconnection
  - Channel subscription management
  - Stream-based event distribution
- [ ] Chat list screen
  - List of conversations sorted by recent
  - Last message preview
  - Unread count badge
  - Online status indicators
- [ ] Chat detail screen
  - Message list (scrollable, paginated)
  - Message bubbles (sent vs received styling)
  - Message input with send button
  - Real-time incoming messages via WebSocket
  - Typing indicator (client-side whisper events)

### Verification

1. Open 2 Flutter desktop instances
2. Register/login as different users on each
3. Create a conversation between them
4. Send a message from User A -> appears in real-time on User B
5. Verify online status shows correctly
6. Verify unread count updates

---

## Phase 2: Sprite Character System

**Goal**: Messages are delivered by animated 2D sprite characters that run across the screen. Characters pass through relay users' screens on the way to their destination.

### Backend Tasks

- [ ] RoutingService
  - Calculate delivery path based on online users
  - Direct mode: [sender, receiver]
  - Relay mode: [sender, random_online_user, receiver]
- [ ] Update MessageSent event payload
  - Include delivery path array
  - Include sender's character skin
  - Include role per recipient (sender/relay/destination)
- [ ] Add `message.delivery` event (separate from `message.new`)
  - `message.new` updates chat UI
  - `message.delivery` triggers character animation

### Frontend Tasks

- [ ] Flame engine integration
  - Create `SpriteOverlayGame` (FlameGame subclass)
  - Transparent GameWidget overlay on top of Flutter UI
  - Bridge between Riverpod and Flame via GameProvider
- [ ] Create placeholder sprite sheets
  - Simple 64x64 character (can be basic shapes initially)
  - States: idle (4 frames), run (6 frames), sleep (4 frames), deliver (4 frames), wave (4 frames)
  - PNG strip format or Aseprite JSON+PNG
- [ ] MessengerCharacter component
  - Extends SpriteAnimationComponent
  - Loads sprite sheets per state
  - State machine: spawn -> running -> idle/sleep -> delivering -> exit
  - Horizontal movement with configurable speed
  - Flip sprite based on direction
- [ ] CharacterController
  - Manages character state transitions
  - Handles spawn position (left/right edge)
  - Manages movement targets (center for relay, chat area for destination)
  - Cleanup on exit (remove from game)
- [ ] DeliveryController
  - Receives WebSocket delivery events
  - Determines animation sequence based on role
  - Spawns character with correct behavior
  - Handles multiple simultaneous characters (Y-offset stacking)
- [ ] Message bubble component (Flame)
  - Rounded rectangle with text
  - Appears above character during deliver state
  - Shows message preview (truncated to ~30 chars)
  - Fade in/out animation
- [ ] Sound effects integration
  - Footstep sounds during run (looped)
  - Pop sound on spawn
  - Ding sound on deliver
  - Snore sound during sleep
  - Volume control + mute toggle
- [ ] Settings additions
  - Character animation toggle (on/off)
  - Sound effects toggle (on/off)
  - Animation speed preference

### Verification

1. Open 3 Flutter instances (PC1, PC2, PC3)
2. All logged in as different users
3. PC1 sends message to PC2:
   - PC2 sees character enter from left, run across, deliver message bubble, wave, exit
4. PC1 sends message to PC3 (with PC2 as relay):
   - PC2 sees character enter, run to center, idle/sleep for 2-3s, continue running, exit right
   - PC3 sees character enter from left, run to chat area, deliver message, wave, exit
5. Sounds play correctly during animations
6. Multiple messages in quick succession show multiple characters with Y-offset

---

## Phase 3: AI Integration

**Goal**: Characters change their behavior based on message sentiment. Happy messages get bouncy characters with sparkles, urgent messages get sprinting characters with alert effects.

### Backend Tasks

- [ ] Ollama setup and configuration
  - Install Ollama on development machine
  - Pull llama3.2:3b model
  - Add Ollama config to config/services.php and .env
- [ ] SentimentService
  - HTTP client to Ollama API
  - Structured prompt for sentiment classification
  - JSON response parsing with validation
  - Timeout handling (15s max, skip on failure)
  - Return: {emotion, urgency, speed, summary}
- [ ] AnalyzeSentimentJob (queued)
  - Receives message ID
  - Calls SentimentService
  - Updates message record with sentiment data
  - Broadcasts SentimentAnalyzed event
  - Max 1 retry, graceful failure
- [ ] SentimentAnalyzed broadcast event
  - Payload: message_id, sentiment, animation_update
  - Broadcast to all users in delivery path
- [ ] Update MessageController to dispatch sentiment job after send

### Frontend Tasks

- [ ] Handle `message.sentiment` WebSocket event
  - Find active character by message_id
  - Update character animation mid-delivery
- [ ] Emotion-specific sprite animations
  - Happy: bouncy skip cycle
  - Sad: slow trudge cycle
  - Urgent: panicked sprint cycle
  - Excited: jumping run cycle
  - Angry: stomping cycle
- [ ] Speed modulation
  - Apply speed multiplier based on sentiment
  - Smooth speed transition (don't snap)
- [ ] Particle effects (Flame ParticleSystemComponent)
  - Sparkles/stars for happy
  - Rain drops for sad
  - Red exclamation marks for urgent
  - Confetti for excited
  - Smoke puffs for angry
- [ ] Delivery bubble styling per emotion
  - Color-coded bubbles (pink for happy, blue for sad, red for urgent)
  - Bubble animation variation (bouncy, gentle, shaking)
- [ ] AI message summary display
  - For long messages (>100 chars), show AI summary in bubble
  - Full message still appears in chat UI
- [ ] Sound variation per emotion
  - Happy: chime sound
  - Sad: soft tone
  - Urgent: alert beep
  - Excited: celebration
  - Default: standard ding

### Verification

1. Send "Good morning! Have a wonderful day! :)" -> character skips happily with sparkles
2. Send "URGENT: Reply ASAP!!!" -> character sprints with red exclamation particles
3. Send "I'm feeling sad today..." -> character walks slowly with droopy animation
4. Send "WE WON!!!" -> character jumps excitedly with confetti
5. Send "ok" -> character runs normally, no special effects
6. Send a long message (>100 chars) -> bubble shows AI summary
7. Disconnect Ollama -> messages still send, character uses default animation
8. Verify AI doesn't block message delivery (message appears first)

---

## Phase 4: Polish & Personality

**Goal**: Make the app feel alive, delightful, and ready for others to use. This is where the app transforms from "functional" to "magical."

### Character Enhancements

- [ ] Multiple character skins
  - Default, Bunny, Cat, Bear, Fox, Penguin
  - Each with full animation set
  - Skin selector in user profile settings
  - Messages delivered by sender's chosen character
- [ ] Idle companion mode
  - After 30s of no messages, character appears on screen
  - Sits at bottom of screen
  - Random idle behaviors every 10-20s:
    - Look around
    - Yawn and stretch
    - Sit down
    - Play with small object
    - Wave at user
  - Disappears when user starts typing
- [ ] Character interaction system
  - When 2+ characters on screen simultaneously:
    - They notice each other
    - Wave or bow
    - Brief chat animation (speech bubbles with "...")
    - Bump into each other and bounce back
  - Adds surprise and delight

### UI Polish

- [ ] Onboarding flow
  - Welcome screen with character introduction
  - Character skin selection
  - Quick tutorial showing delivery animation
- [ ] Desktop notifications
  - System tray integration
  - Native Windows notifications for messages
  - Notification shows sender name + character icon
- [ ] Conversation search
  - Search messages within conversations
  - Search across all conversations
- [ ] Message reactions
  - Long-press to react with emoji
  - Character delivers reaction animation
- [ ] Read receipts
  - Double-check marks when message is read
  - Subtle, not intrusive

### Settings & Preferences

- [ ] Animation settings
  - Master toggle: animations on/off
  - Focus mode: suppress all character animations
  - Animation speed: slow/normal/fast
  - Idle companion: on/off
- [ ] Sound settings
  - Master volume slider
  - Individual toggles: footsteps, delivery, ambient
  - Mute all
- [ ] Appearance settings
  - Theme: light (default) / dark (future)
  - Chat bubble style options
  - Font size adjustment
- [ ] Character settings
  - Skin selector with preview
  - Character name customization

### Performance & Quality

- [ ] Profile app with Flutter DevTools
  - Ensure 60fps during character animations
  - Optimize sprite sheet loading (cache)
  - Reduce unnecessary widget rebuilds
- [ ] Memory management
  - Properly dispose characters after exit
  - Limit max concurrent characters (5 max)
  - Recycle particle systems
- [ ] Error resilience
  - Graceful WebSocket reconnection
  - Offline message queue
  - AI failure fallback (silent)
- [ ] Final sprite art
  - Commission or create professional Aseprite sprites
  - Consistent style across all skins
  - All animation states polished

### Verification

1. Select different character skins for 3 users -> each message delivered by sender's character
2. Wait 30s idle -> companion character appears, performs random actions
3. Send 2 messages simultaneously -> characters interact on screen
4. Close app -> system tray notification appears for new message
5. Toggle animations off -> messages arrive without character animation
6. Run performance profiler -> consistent 60fps during animations
7. Disconnect internet -> app handles gracefully, reconnects when available
