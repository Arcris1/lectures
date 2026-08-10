# SpriteChat - AI Sentiment Analysis System

## Overview

The AI sentiment system analyzes messages to determine emotional tone, urgency, and appropriate character behavior. It runs asynchronously so messages are delivered instantly while AI enriches the experience after the fact.

---

## Architecture

```
Message Sent (instant)
    |
    +---> Broadcast message.delivery (immediate, no AI)
    |     Character starts with default animation
    |
    +---> Queue: AnalyzeSentimentJob
              |
              v
          Ollama API (localhost:11434)
              |
              v
          Parse AI response
              |
              v
          Save sentiment to DB
              |
              v
          Broadcast message.sentiment
              |
              v
          Flutter updates character animation mid-delivery
```

**Key principle**: Never block message delivery waiting for AI. Send first, enrich later.

---

## Ollama Setup

### Model

- **Recommended**: `llama3.2:3b` (2GB, 1-2 second response)
- **Lightweight**: `llama3.2:1b` (1.3GB, <1 second)
- **Endpoint**: `http://localhost:11434/api/generate`

### Installation

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull the model
ollama pull llama3.2:3b

# Verify
ollama run llama3.2:3b "Hello"
```

---

## Prompt Design

### Sentiment Classification Prompt

```
You are a message sentiment analyzer for a cute messaging app.

Analyze this message and return ONLY a JSON object with these fields:
- emotion: one of [happy, sad, urgent, excited, neutral, angry]
- urgency: one of [low, medium, high]
- speed: one of [slow, normal, fast]
- summary: a 5-10 word summary (for long messages only, null for short ones)

Message: "{message_content}"

JSON:
```

### Expected Response

```json
{
  "emotion": "happy",
  "urgency": "low",
  "speed": "normal",
  "summary": null
}
```

### Example Classifications

| Message | Emotion | Urgency | Speed |
|---------|---------|---------|-------|
| "Good morning! Have a nice day :)" | happy | low | normal |
| "BRO REPLY ASAP!!!" | urgent | high | fast |
| "I failed the exam..." | sad | low | slow |
| "WE WON THE GAME!!!" | excited | medium | fast |
| "Can you send me the file?" | neutral | medium | normal |
| "Why didn't you respond to my calls??" | angry | high | fast |
| "Meeting at 3pm" | neutral | medium | normal |
| "I miss you" | sad | low | slow |
| "HAHAHA that's hilarious" | happy | low | normal |
| "EMERGENCY! Server is down!" | urgent | high | fast |

---

## Laravel Integration

### SentimentService

```php
class SentimentService
{
    private string $ollamaUrl;
    private string $model;
    private int $timeout;

    public function __construct()
    {
        $this->ollamaUrl = config('services.ollama.url', 'http://localhost:11434');
        $this->model = config('services.ollama.model', 'llama3.2:3b');
        $this->timeout = config('services.ollama.timeout', 15);
    }

    public function analyze(string $content): ?array
    {
        // Build prompt
        // POST to Ollama /api/generate
        // Parse JSON from response
        // Validate fields
        // Return structured array or null on failure
    }
}
```

### AnalyzeSentimentJob

```
Queue: redis
Connection: default
Timeout: 30 seconds
Max retries: 1 (don't retry - if AI fails, skip gracefully)

Flow:
1. Receive message ID
2. Load message from DB
3. Call SentimentService->analyze(message->content)
4. If result:
   - Update message: sentiment_emotion, sentiment_urgency
   - Broadcast SentimentAnalyzed event to relevant users
5. If null (failure/timeout):
   - Log warning
   - Do nothing (character keeps default animation)
```

---

## Sentiment -> Animation Mapping

### Character Behavior

| Emotion | Run Animation | Speed (px/s) | Expression | Particles |
|---------|--------------|-------------|------------|-----------|
| `happy` | Bouncy skip | 150 | Smiling, sparkle eyes | Sparkles/stars |
| `sad` | Slow trudge | 80 | Droopy eyes, head down | Small rain drops |
| `urgent` | Panicked sprint | 300 | Wide eyes, sweat drop | Red exclamation marks |
| `excited` | Jumping run | 250 | Star eyes, big smile | Confetti |
| `neutral` | Standard run | 150 | Normal expression | None |
| `angry` | Stomping walk | 200 | Frown, red cheeks | Smoke puffs |

### Speed Multiplier

```
speed: "slow"   -> 0.6x base speed
speed: "normal" -> 1.0x base speed
speed: "fast"   -> 1.8x base speed
```

### Delivery Behavior Changes

| Emotion | Deliver Animation | Bubble Style | Sound |
|---------|------------------|-------------|-------|
| `happy` | Character jumps, hearts | Pink bubble, bouncy | Happy chime |
| `sad` | Character sighs, looks down | Blue bubble, gentle | Soft tone |
| `urgent` | Character waves frantically | Red bubble, shaking | Alert beep |
| `excited` | Character dances | Rainbow bubble | Celebration fanfare |
| `neutral` | Standard wave | White bubble | Standard ding |
| `angry` | Character stomps | Orange bubble, bold | Thud sound |

---

## Error Handling

### Graceful Degradation

The AI system must NEVER break the messaging experience:

| Failure Scenario | Behavior |
|-----------------|----------|
| Ollama not running | Skip AI, character uses default animation |
| Ollama timeout (>15s) | Skip AI, log warning |
| Invalid JSON response | Skip AI, log error |
| Unrecognized emotion | Map to "neutral" |
| Queue worker down | Messages still sent, no sentiment events |

### Monitoring

Log these for debugging:
- AI response time per message
- Failed classification count
- Model accuracy (manual spot checks)
- Queue backlog size

---

## Configuration

### Environment Variables

```env
# Ollama Settings
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:3b
OLLAMA_TIMEOUT=15

# Feature Flags
AI_SENTIMENT_ENABLED=true
AI_SUMMARY_ENABLED=true
AI_SUMMARY_MIN_LENGTH=100
```

### Laravel Config (config/services.php)

```php
'ollama' => [
    'url' => env('OLLAMA_URL', 'http://localhost:11434'),
    'model' => env('OLLAMA_MODEL', 'llama3.2:3b'),
    'timeout' => env('OLLAMA_TIMEOUT', 15),
    'enabled' => env('AI_SENTIMENT_ENABLED', true),
    'summary_enabled' => env('AI_SUMMARY_ENABLED', true),
    'summary_min_length' => env('AI_SUMMARY_MIN_LENGTH', 100),
],
```

---

## Future AI Features

### Phase 3+

1. **Message Summary**: For messages >100 characters, AI generates a 5-10 word summary displayed in the character's speech bubble
2. **Smart Reply Suggestions**: AI suggests 2-3 quick replies based on message context
3. **Character Personality**: Each character skin has a prompt persona that flavors delivery text
4. **Conversation Mood Tracking**: Track emotional trend over a conversation, adjust ambient UI
5. **Priority Routing**: AI determines if message should go direct (urgent) or can take scenic route (casual)

### Phase 4+

6. **Memory System (Qdrant)**: Characters remember past interactions, react differently to frequent contacts
7. **Context-Aware Reactions**: Character reacts to message content (food mention = drooling animation)
8. **Auto-categorization**: AI tags messages (question, request, greeting, farewell) for smart filtering
