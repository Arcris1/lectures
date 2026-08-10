# SpriteChat - Character Delivery System

## Overview

The character system is the heart of SpriteChat. It transforms boring notifications into a living, animated delivery experience. Characters are 2D sprites powered by the Flame engine that run across the desktop screen to deliver messages.

---

## Character State Machine

```
                    +--------+
                    | SPAWN  |
                    +---+----+
                        |
                        v
                   +---------+
              +--->| RUNNING |----+
              |    +----+----+   |
              |         |        |
              |    +----v----+   |
              |    |  IDLE   |   |  (relay node only)
              |    | /SLEEP  |   |
              |    +----+----+   |
              |         |        |
              +---------+        |
                                 |
                    +------------v---+
                    |  DELIVERING    |  (destination only)
                    |  (show bubble) |
                    +-------+--------+
                            |
                       +----v----+
                       |  EXIT   |
                       +---------+
```

### States Explained

| State | Animation | Duration | Description |
|-------|-----------|----------|-------------|
| `spawn` | Appear/pop-in | 0.3s | Character materializes at screen edge with a small poof effect |
| `running` | Run cycle | Variable | Character moves horizontally across screen. Speed based on sentiment |
| `idle` | Standing/looking around | 1-2s | Brief pause at relay node. Character looks around curiously |
| `sleep` | Sleeping/sitting | 2-3s | Longer pause at relay node. Character sits down and naps |
| `delivering` | Waving + speech bubble | 2-3s | Character stops, speech bubble appears with message preview |
| `exit` | Run off-screen | 0.5s | Character runs past the screen edge and is removed |

---

## Delivery Scenarios

### Scenario 1: Direct Message (PC1 -> PC2)

```
PC1 (Sender)                    PC2 (Receiver)
+---------------------------+   +---------------------------+
|                           |   |  <- [char spawns]         |
|  "Sending..."             |   |     [runs across] ->     |
|                           |   |        [stops]            |
|                           |   |     "Hey!" [bubble]       |
|                           |   |     [waves] -> [exits]    |
+---------------------------+   +---------------------------+
```

Timeline:
1. `0.0s` - Character spawns at left edge of PC2's screen
2. `0.0-2.0s` - Runs across screen toward chat area
3. `2.0s` - Stops, plays deliver animation
4. `2.0-4.0s` - Speech bubble appears with message preview
5. `4.0-4.5s` - Character waves and runs off-screen

### Scenario 2: Routed Message (PC1 -> PC3 via PC2)

```
PC2 (Relay)                     PC3 (Destination)
+---------------------------+   +---------------------------+
|  <- [char spawns]         |   |                           |
|     [runs to center] ->   |   |                           |
|        [sits down]        |   |                           |
|        [zzz... rests]     |   |                           |
|     [wakes up]            |   |                           |
|     [runs off] ---------->|-->|  <- [char spawns]         |
|                           |   |     [runs across] ->     |
|                           |   |        [stops]            |
|                           |   |     "Hey!" [bubble]       |
|                           |   |     [waves] -> [exits]    |
+---------------------------+   +---------------------------+
```

Timeline on PC2 (relay):
1. `0.0s` - Character spawns at left edge
2. `0.0-1.5s` - Runs to center of screen
3. `1.5-3.5s` - Plays idle/sleep animation (resting)
4. `3.5-4.0s` - Wakes up, continues running right
5. `4.0-4.5s` - Exits screen to the right

Timeline on PC3 (destination) - starts ~4.5s after PC2:
1. `4.5s` - Character spawns at left edge
2. `4.5-6.5s` - Runs across to chat area
3. `6.5-8.5s` - Delivers message with speech bubble
4. `8.5-9.0s` - Waves and exits

### Scenario 3: Multi-Relay (PC1 -> PC4 via PC2, PC3)

Same pattern, but the character passes through multiple screens. Each relay sees the idle/rest animation before the character continues.

---

## AI Sentiment Integration

### Sentiment -> Animation Mapping

| Emotion | Run Speed | Animation Style | Particles | Sound |
|---------|-----------|----------------|-----------|-------|
| `happy` | Normal (150px/s) | Bouncy skip | Sparkles | Happy chime |
| `sad` | Slow (80px/s) | Trudging walk | Rain drops | Soft tone |
| `urgent` | Fast (300px/s) | Panicked sprint | Red exclamation | Alert beep |
| `excited` | Fast (250px/s) | Jumping run | Confetti | Celebration |
| `neutral` | Normal (150px/s) | Standard run | None | Footsteps |
| `angry` | Fast (200px/s) | Stomping | Smoke puffs | Stomp sounds |

### Two-Phase Animation

Since AI analysis is async (1-3 seconds), the character starts with a default animation and updates mid-delivery:

```
Phase 1 (Immediate - message sent):
  Character spawns with "neutral" animation
  Starts running at normal speed

Phase 2 (AI result arrives - 1-3s later):
  Character smoothly transitions to sentiment animation
  Speed adjusts (faster/slower)
  Particle effects appear
  Expression changes
```

This ensures the character appears instantly - no waiting for AI.

---

## Sprite Sheet Specifications

### Character Design Style

- **Art style**: Chibi/kawaii - big head (60% of body), small body, large expressive eyes
- **Pixel size**: 64x64 pixels per frame
- **Display size**: Scaled to 96-128px on desktop screens
- **Color palette**: Soft, pastel tones matching the app theme
- **Outline**: 1px dark outline for clarity against any background

### Required Animation States

| State | Frames | Loop | Notes |
|-------|--------|------|-------|
| `idle` | 8 | Yes | Breathing motion, occasional blink |
| `idle_blink` | 4 | No | Quick blink, triggered randomly |
| `run` | 6 | Yes | Standard run cycle |
| `run_fast` | 6 | Yes | Same cycle, faster playback |
| `run_slow` | 6 | Yes | Trudging, heavier steps |
| `sleep` | 4 | Yes | Sitting with zzz bubbles |
| `deliver` | 6 | No | Stop, hold up letter/bubble |
| `happy` | 4 | No | Jump with sparkle eyes |
| `alert` | 4 | No | Surprised look, exclamation |
| `wave` | 4 | No | Friendly wave goodbye |

### Sprite Sheet Format

Using Aseprite JSON+PNG export:

```
assets/sprites/character_default/
  idle.json       <- Frame positions, durations
  idle.png        <- Sprite strip image
  run.json
  run.png
  sleep.json
  sleep.png
  deliver.json
  deliver.png
  happy.json
  happy.png
  alert.json
  alert.png
  wave.json
  wave.png
```

Each JSON file contains Aseprite frame data:
```json
{
  "frames": {
    "idle_0": { "frame": {"x": 0, "y": 0, "w": 64, "h": 64}, "duration": 120 },
    "idle_1": { "frame": {"x": 64, "y": 0, "w": 64, "h": 64}, "duration": 120 },
    ...
  },
  "meta": {
    "size": {"w": 512, "h": 64},
    "frameTags": [{"name": "idle", "from": 0, "to": 7}]
  }
}
```

---

## Character Controller Logic

### Delivery Flow (Pseudocode)

```
onDeliveryEvent(event):
  role = event.role  // "relay" or "destination"

  character = spawnCharacter(edge: LEFT, skin: event.character.skin)
  character.setState(RUNNING)
  character.setSpeed(DEFAULT_SPEED)

  if role == "relay":
    character.moveTo(screenCenter)
    character.onArrival:
      character.setState(IDLE or SLEEP)
      wait(2-3 seconds)
      character.setState(RUNNING)
      character.moveTo(screenRight + 100)  // off-screen
      character.onArrival:
        character.remove()

  if role == "destination":
    character.moveTo(chatAreaPosition)
    character.onArrival:
      character.setState(DELIVERING)
      showMessageBubble(event.message_preview)
      wait(2.5 seconds)
      character.setState(WAVE)
      wait(0.5 seconds)
      character.setState(RUNNING)
      character.moveTo(screenRight + 100)
      character.onArrival:
        character.remove()

onSentimentUpdate(event):
  character = findActiveCharacter(event.message_id)
  if character exists and still on screen:
    character.setMood(event.sentiment.emotion)
    character.setSpeed(event.sentiment.speed)
    character.showParticles(event.animation_update.particles)
```

### Multiple Simultaneous Characters

If multiple messages arrive at once, characters queue up or run at different Y-positions:

```
+---------------------------+
|   [char1] ->              |  y = bottom - 20px
|          [char2] ->       |  y = bottom - 80px
|   "Hello!"                |
|              [char3] ->   |  y = bottom - 140px
+---------------------------+
```

Each character gets a unique Y-offset to avoid overlap.

---

## Sound Design

| Event | Sound | Duration | Volume |
|-------|-------|----------|--------|
| Character spawn | Soft "pop" | 0.3s | 60% |
| Running | Tiny footsteps (loop) | Continuous | 30% |
| Idle/sit | None or soft yawn | 0.5s | 40% |
| Sleep | Quiet snore (loop) | Continuous | 20% |
| Message deliver | "Ding!" chime | 0.5s | 80% |
| Wave goodbye | None | - | - |
| Happy mood | Sparkle sound | 0.3s | 50% |
| Urgent mood | Alert beep | 0.3s | 70% |

All sounds must have a global toggle in settings. Default: ON.

---

## Future Enhancements (Phase 4+)

### Idle Companion Mode
- Character stays on screen when no messages
- Random idle behaviors: sit, look around, yawn, play, stretch
- Reacts to mouse proximity (looks at cursor)
- Shows status ("Waiting for messages...")

### Character Skins
- Each user selects their character (bunny, cat, bear, fox, etc.)
- Messages are delivered by the SENDER's character
- Unlock new skins as achievements

### Character Interactions
- If two characters are on screen simultaneously:
  - They wave at each other
  - They bump and bounce back
  - They sit and chat briefly
- Adds personality and surprise to the experience

### Message Weight System
- Short message: character runs normally
- Long message: character carries a heavy sack, runs slower
- Image/file: character pushes a cart
- Emoji-only: character floats/flies
