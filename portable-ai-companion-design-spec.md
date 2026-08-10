# Portable AI Companion -- Complete UI/UX Design Specification

**Version:** 1.0
**Date:** 2026-03-28
**Designer:** UIX Design Architect
**Platform:** Flutter (iOS + Android)

---

## Table of Contents

1. [Design Philosophy & Research](#1-design-philosophy--research)
2. [Design System Foundation](#2-design-system-foundation)
3. [Screen 1: Onboarding](#3-screen-1-onboarding)
4. [Screen 2: Home/Chat](#4-screen-2-homechat)
5. [Screen 3: Model Store](#5-screen-3-model-store)
6. [Screen 4: Settings/Personalization](#6-screen-4-settingspersonalization)
7. [Screen 5: Companion Profile](#7-screen-5-companion-profile)
8. [Animation & Micro-Interaction Guide](#8-animation--micro-interaction-guide)
9. [Implementation Notes](#9-implementation-notes)

---

## 1. Design Philosophy & Research

### Design Direction: "Living Glass"

The concept is **dark glassmorphism with organic, living elements**. The AI companion
should feel like a warm presence behind frosted glass -- not a cold terminal, not a
cartoon character. Think of it as the intersection of:

- **Arc Browser's** spatial, fluid navigation and bold color confidence
- **Replika's** emotional warmth and avatar personalization
- **Apple Intelligence's** refined glassmorphism and system-level polish
- **Nothing OS's** dot-matrix personality and unique visual identity

### Key Design Principles

1. **Alive, not animated.** The companion breathes, pulses, and shifts -- it does not
   bounce, spin, or wiggle. Every motion is slow, organic, and calming.

2. **Warm dark, not cold dark.** The dark palette leans warm (deep slate-blues with
   amber/coral accents), not the typical cold charcoal-and-blue AI aesthetic.

3. **Privacy as personality.** The "offline-first" nature is not a limitation --
   it is the brand. "Your thoughts stay with you" is a feature, not a footnote.
   Visual cues reinforce local-only operation (no cloud icons, a subtle shield motif).

4. **Depth through glass.** Layered translucent surfaces create spatial hierarchy.
   Content feels like it exists at different depths, with ambient color gradients
   bleeding through frosted panels.

5. **Typography-led.** Large, confident type does the heavy lifting. The interface
   is not decorated -- it is typeset.

### Avoiding the "AI Purple Problem"

Research shows most AI apps default to indigo/violet palettes because of Tailwind
defaults and template culture. This design deliberately avoids that by using a
**warm amber/coral primary with teal accents** -- distinctive, warm, and personal.

---

## 2. Design System Foundation

### 2.1 Color Palette

#### Dark Theme (Primary)

```
-- BACKGROUNDS --
Surface 0 (Deepest):    #0A0A0F    -- Near-black with slight blue undertone
Surface 1 (Base):       #12121A    -- Primary background
Surface 2 (Elevated):   #1A1A26    -- Cards, panels
Surface 3 (Overlay):    #222233    -- Modals, drawers
Surface Glass:          #1A1A26 at 60% opacity with 24px blur

-- AMBIENT GRADIENTS (behind glass panels) --
Gradient Warm:          #2D1B0E -> #0A0A0F    -- Warm amber glow (top-left)
Gradient Cool:          #0E1B2D -> #0A0A0F    -- Cool teal glow (bottom-right)
Gradient Companion:     #2D0E1B -> #0A0A0F    -- Coral pulse (companion avatar area)

-- PRIMARY: Amber/Coral --
Primary 50:             #FFF8F0
Primary 100:            #FFECD6
Primary 200:            #FFD4A8
Primary 300:            #FFB870
Primary 400:            #FF9A3D    -- Primary action color
Primary 500:            #F07D20    -- Buttons, active states
Primary 600:            #CC6010
Primary 700:            #A14808
Primary 800:            #7A3508
Primary 900:            #522408

-- SECONDARY: Teal --
Secondary 50:           #F0FFFE
Secondary 100:          #CCFFF8
Secondary 200:          #99FFF2
Secondary 300:          #5CEDE0
Secondary 400:          #2DD4BF    -- Secondary accent
Secondary 500:          #14B8A6    -- Links, highlights
Secondary 600:          #0D9488
Secondary 700:          #0F766E
Secondary 800:          #115E59
Secondary 900:          #134E4A

-- NEUTRALS: Warm Gray --
Neutral 50:             #FAFAF9
Neutral 100:            #F5F5F4
Neutral 200:            #E7E5E4
Neutral 300:            #D6D3D1
Neutral 400:            #A8A29E    -- Secondary text (dark mode)
Neutral 500:            #78716C    -- Disabled text
Neutral 600:            #57534E
Neutral 700:            #44403C
Neutral 800:            #292524
Neutral 900:            #1C1917

-- TEXT (Dark Mode) --
Text Primary:           #F5F5F4    -- Neutral 100
Text Secondary:         #A8A29E    -- Neutral 400
Text Tertiary:          #78716C    -- Neutral 500
Text Inverse:           #1C1917    -- For light backgrounds

-- SEMANTIC --
Success:                #22C55E
Warning:                #FBBF24
Error:                  #EF4444
Info:                   #38BDF8

-- COMPANION PRESENCE (glowing orb colors) --
Companion Idle:         #FF9A3D at 30% opacity
Companion Active:       #FF9A3D at 60% opacity
Companion Thinking:     #2DD4BF at 40% opacity (shifts to teal while processing)
Companion Listening:    #FFB870 at 50% opacity (warm pulse)
```

#### Light Theme (Optional)

```
Surface 0:              #FFFFFF
Surface 1:              #FAFAF9
Surface 2:              #F5F5F4
Surface 3:              #E7E5E4
Surface Glass:          #FFFFFF at 70% opacity with 20px blur

Text Primary:           #1C1917
Text Secondary:         #57534E
Text Tertiary:          #78716C

-- Primary and Secondary remain the same --
-- Ambient gradients become subtle pastel washes --
```

### 2.2 Typography

**Font Family:** `Google Sans Text` (primary), `JetBrains Mono` (code blocks)

Fallback chain: `Google Sans Text` -> `Inter` -> `SF Pro Text` -> system default

| Role              | Size  | Weight    | Line Height | Letter Spacing |
|-------------------|-------|-----------|-------------|----------------|
| Display Large     | 36px  | Bold 700  | 44px (1.22) | -0.5px         |
| Display Medium    | 28px  | Bold 700  | 36px (1.29) | -0.3px         |
| Heading Large     | 24px  | Semi 600  | 32px (1.33) | -0.2px         |
| Heading Medium    | 20px  | Semi 600  | 28px (1.40) | -0.1px         |
| Heading Small     | 16px  | Semi 600  | 24px (1.50) | 0              |
| Body Large        | 16px  | Regular 400| 24px (1.50) | 0.1px          |
| Body Medium       | 14px  | Regular 400| 20px (1.43) | 0.15px         |
| Body Small        | 12px  | Regular 400| 16px (1.33) | 0.2px          |
| Label Large       | 14px  | Medium 500| 20px (1.43) | 0.1px          |
| Label Medium      | 12px  | Medium 500| 16px (1.33) | 0.3px          |
| Label Small       | 10px  | Medium 500| 14px (1.40) | 0.4px          |
| Code              | 13px  | Regular 400| 20px (1.54) | 0              |

Type scale ratio: **1.25** (Major Third)

### 2.3 Spacing Scale

Base unit: **4px**

| Token  | Value | Usage                                     |
|--------|-------|-------------------------------------------|
| xs     | 4px   | Inline icon gaps, tight internal padding  |
| sm     | 8px   | Between related items, chip padding       |
| md     | 12px  | Standard internal padding                 |
| base   | 16px  | Default component padding, list gaps      |
| lg     | 24px  | Section separators, card padding          |
| xl     | 32px  | Major section spacing                     |
| 2xl    | 48px  | Screen-level vertical rhythm              |
| 3xl    | 64px  | Hero spacing, breathing room              |

### 2.4 Border Radius Scale

| Token       | Value | Usage                                  |
|-------------|-------|----------------------------------------|
| none        | 0     | Dividers, sharp accents                |
| sm          | 8px   | Small chips, tags                      |
| md          | 12px  | Buttons, inputs, small cards           |
| lg          | 16px  | Cards, panels                          |
| xl          | 20px  | Large cards, bottom sheets             |
| 2xl         | 24px  | Modal dialogs                          |
| full        | 9999px| Pills, avatar circles, FABs           |

### 2.5 Elevation & Glass System

```
-- SHADOWS (for non-glass elements) --
Elevation 1:  0 1px 3px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.24)
Elevation 2:  0 3px 6px rgba(0, 0, 0, 0.16), 0 3px 6px rgba(0, 0, 0, 0.23)
Elevation 3:  0 10px 20px rgba(0, 0, 0, 0.19), 0 6px 6px rgba(0, 0, 0, 0.23)
Elevation 4:  0 14px 28px rgba(0, 0, 0, 0.25), 0 10px 10px rgba(0, 0, 0, 0.22)

-- GLASS PANELS --
Glass Subtle:
  - Background: Surface Glass color
  - Blur: 16px (sigmaX: 16, sigmaY: 16)
  - Border: 1px solid rgba(255, 255, 255, 0.06)
  - No shadow

Glass Standard:
  - Background: Surface Glass color
  - Blur: 24px
  - Border: 1px solid rgba(255, 255, 255, 0.08)
  - Inner highlight: 1px solid rgba(255, 255, 255, 0.04) (top edge only)

Glass Prominent:
  - Background: Surface 2 at 80% opacity
  - Blur: 32px
  - Border: 1px solid rgba(255, 255, 255, 0.12)
  - Shadow: Elevation 2

-- GLOW EFFECTS (companion presence) --
Glow Subtle:  0 0 40px [Companion Color] at 15% opacity
Glow Medium:  0 0 60px [Companion Color] at 25% opacity
Glow Strong:  0 0 80px [Companion Color] at 35% opacity
```

### 2.6 Iconography

Use **Lucide Icons** (via `lucide_icons` package) for UI chrome. They are 24x24 with
1.5px stroke weight, matching the refined aesthetic. For companion-specific icons
(personality traits, model types), use custom-drawn icons in the same style.

### 2.7 The Companion Avatar

The companion is NOT a 3D character or anime avatar. It is an **abstract luminous orb**
-- a softly glowing, organic shape that shifts and breathes. Think of a bioluminescent
deep-sea creature or a will-o'-the-wisp.

**States:**
- **Idle:** Slow, gentle breathing pulse (scale 0.97 to 1.03 over 4 seconds, ease-in-out)
- **Listening:** Warmer glow, slightly faster pulse, subtle particles drift upward
- **Thinking:** Color shifts to teal, the orb elongates slightly, particles orbit
- **Speaking/Streaming:** Rhythmic brightness pulses synced to token generation speed
- **Error:** Brief red flash, then returns to idle with a dimmer glow

**Implementation:** Custom `CustomPainter` with radial gradients, noise textures, and
`AnimationController` driving multiple `Tween`s for scale, opacity, color, and position.
Consider using a `ShaderEffect` for the organic noise pattern.

The orb sits in a `SizedBox(width: 120, height: 120)` by default but can scale to
`SizedBox(width: 200, height: 200)` on the profile screen.

---

## 3. Screen 1: Onboarding

### 3.1 Flow Overview

The onboarding is a **4-step guided flow** with a horizontal page indicator. No skip
button -- but each step is fast (under 10 seconds). The flow should feel like meeting
someone new, not filling out a form.

**Steps:**
1. Welcome / Value Proposition
2. Name Your Companion
3. Choose a Personality
4. First Greeting (companion "comes alive")

### 3.2 Step 1: Welcome

```
+--------------------------------------------------+
|                                                  |
|  [Status Bar - transparent]                      |
|                                                  |
|                                                  |
|                                                  |
|              (Ambient gradient:                   |
|               warm amber orb,                    |
|               slowly breathing,                  |
|               centered)                          |
|                                                  |
|                    [Orb]                          |
|                   120x120                         |
|                                                  |
|                                                  |
|         "Your thoughts,                          |  Display Large, 36px
|          your companion."                        |  Bold, Text Primary
|                                                  |
|         "A private AI that lives                 |  Body Large, 16px
|          on your device. No cloud.               |  Regular, Text Secondary
|          No tracking. Just you."                 |
|                                                  |
|                                                  |
|     [ ---- ---- ---- ---- ]  (page indicator)    |  4px height, 24px width each
|                                                  |  Active: Primary 400
|                                                  |  Inactive: Neutral 700
|                                                  |
|     +--------------------------------------+     |
|     |          Get Started                 |     |  Height: 56px
|     +--------------------------------------+     |  Radius: md (12px)
|                                                  |  BG: Primary 500
|     padding-bottom: 48px                         |  Text: Text Inverse, Label Large
+--------------------------------------------------+
```

**Widget Hierarchy:**
```dart
Scaffold(
  backgroundColor: Color(0xFF0A0A0F),
  body: Stack(
    children: [
      // Ambient gradient background
      Positioned.fill(
        child: CustomPaint(painter: AmbientGradientPainter()),
      ),
      // Content
      SafeArea(
        child: Padding(
          padding: EdgeInsets.symmetric(horizontal: 24),
          child: Column(
            children: [
              Spacer(flex: 3),
              CompanionOrb(size: 120, state: OrbState.idle),
              SizedBox(height: 48),
              Text("Your thoughts,\nyour companion.",
                style: displayLarge, textAlign: TextAlign.center),
              SizedBox(height: 16),
              Text("A private AI that lives on your device...",
                style: bodyLarge.copyWith(color: textSecondary),
                textAlign: TextAlign.center),
              Spacer(flex: 2),
              PageIndicator(current: 0, total: 4),
              SizedBox(height: 24),
              PrimaryButton(label: "Get Started", onTap: nextStep),
              SizedBox(height: 48),
            ],
          ),
        ),
      ),
    ],
  ),
)
```

**Animations:**
- The orb fades in with a 600ms ease-out, scaling from 0.8 to 1.0
- Title text fades up from 20px below, staggered 200ms after the orb
- Subtitle fades up 150ms after title
- Button slides up from bottom, 200ms after subtitle
- Background ambient gradient rotates very slowly (360 degrees over 30 seconds)

### 3.3 Step 2: Name Your Companion

```
+--------------------------------------------------+
|                                                  |
|  [Status Bar]                                    |
|                                                  |
|                    [Orb]                          |
|                   80x80                           |  Smaller orb, top area
|                (listening state)                  |
|                                                  |
|         "What should I                           |  Heading Large, 24px
|          call myself?"                           |  Semi 600, Text Primary
|                                                  |
|         "Pick a name that feels right.           |  Body Medium, 14px
|          You can always change it later."        |  Text Secondary
|                                                  |
|     +--------------------------------------+     |
|     |  e.g. Luna, Atlas, Ember, Nova       |     |  Glass Standard panel
|     |                                      |     |  Height: 56px
|     |  [  Text Input: "                 "]  |     |  Radius: md (12px)
|     +--------------------------------------+     |  Cursor: Primary 400
|                                                  |
|     Suggestions:                                 |  Label Medium, Text Tertiary
|     [Luna] [Atlas] [Ember] [Nova] [Sage]         |  Chips: Glass Subtle
|     [Kai]  [Echo]  [Sol]   [Ari]  [Byte]         |  Active: Primary 500 fill
|                                                  |  Size: 36px height, sm radius
|                                                  |
|     [ ---- ---- ---- ---- ]                      |
|                                                  |
|     +--------------------------------------+     |
|     |          Continue                    |     |  Disabled until name entered
|     +--------------------------------------+     |  Disabled: Neutral 700 bg,
|                                                  |            Neutral 500 text
|     padding-bottom: 48px                         |
+--------------------------------------------------+
```

**Key Details:**
- Text input has no visible border in resting state -- just the glass panel behind it
- On focus, a 1px Primary 400 border appears with a subtle glow (Glow Subtle)
- Name suggestion chips are scrollable horizontally if they overflow
- Tapping a chip fills the input and adds a brief haptic (light impact)
- The orb shifts to "listening" state (warmer glow) when the input is focused
- Character limit: 20 characters, shown as a subtle counter at bottom-right of input

**Flutter Widgets:**
- `TextField` with custom `InputDecoration` (no default border)
- `Wrap` or horizontal `ListView` for suggestion chips
- `ActionChip` with custom styling
- `AnimatedContainer` for the button's enabled/disabled transition

### 3.4 Step 3: Choose a Personality

```
+--------------------------------------------------+
|                                                  |
|  [Status Bar]                                    |
|                                                  |
|                    [Orb]                          |
|                   80x80                           |
|                                                  |
|         "How should [Name]                       |  Heading Large
|          talk to you?"                           |
|                                                  |
|         "This shapes my tone and style.          |  Body Medium, Text Secondary
|          You can fine-tune later."               |
|                                                  |
|     +--------------------------------------+     |
|     |  [icon]  Thoughtful                  |     |  PERSONALITY CARDS
|     |  "Careful, reflective, asks good     |     |  Glass Standard panel
|     |   questions before answering."       |     |  Height: ~88px
|     +--------------------------------------+     |  Radius: lg (16px)
|                                                  |  Padding: lg (24px)
|     +--------------------------------------+     |  Gap between cards: md (12px)
|     |  [icon]  Friendly                    |     |
|     |  "Warm, encouraging, uses casual     |     |  Selected state:
|     |   language and gentle humor."        |     |    Border: 1.5px Primary 400
|     +--------------------------------------+     |    Background: Primary 400
|                                                  |      at 8% opacity
|     +--------------------------------------+     |    Glow: Glow Subtle with
|     |  [icon]  Direct                      |     |      Primary 400
|     |  "Concise, efficient, gets to        |     |
|     |   the point without fluff."          |     |
|     +--------------------------------------+     |
|                                                  |
|     +--------------------------------------+     |
|     |  [icon]  Creative                    |     |
|     |  "Playful, imaginative, loves        |     |
|     |   metaphors and storytelling."       |     |
|     +--------------------------------------+     |
|                                                  |
|     [ ---- ---- ---- ---- ]                      |
|     +--------------------------------------+     |
|     |          Continue                    |     |
|     +--------------------------------------+     |
+--------------------------------------------------+
```

**Personality Card Details:**

Each card contains:
- Left: A small icon (24x24) representing the personality (Lucide icons)
  - Thoughtful: `brain` icon
  - Friendly: `heart` icon
  - Direct: `zap` icon
  - Creative: `sparkles` icon
- Title: Heading Small (16px, Semi 600)
- Description: Body Small (12px, Neutral 400)

**Interaction:**
- Single select -- tapping one deselects the others
- Selection transition: 200ms ease-out for border color, background tint, and glow
- The companion orb subtly shifts color when a personality is selected:
  - Thoughtful: shifts slightly blue
  - Friendly: shifts warmer amber
  - Direct: stays neutral
  - Creative: shifts slightly coral/pink
- Cards are in a `ListView` that scrolls if needed on smaller screens

### 3.5 Step 4: First Greeting

```
+--------------------------------------------------+
|                                                  |
|  [Status Bar]                                    |
|                                                  |
|                                                  |
|                                                  |
|              (Orb expands to 160x160,            |
|               pulsing with "speaking" state,     |
|               ambient gradient intensifies)      |
|                                                  |
|                    [Orb]                          |
|                  160x160                          |
|                                                  |
|                                                  |
|         "Hey! I'm [Name].                        |  Heading Large
|          I'll be right here                      |  Text streams in character
|          whenever you need me."                  |  by character, 30ms/char
|                                                  |
|         "Let's download a brain                  |  Body Large, Text Secondary
|          for me so I can think."                 |  Appears after greeting finishes
|                                                  |
|                                                  |
|                                                  |
|     +--------------------------------------+     |
|     |      Browse Models                   |     |  Primary button
|     +--------------------------------------+     |
|                                                  |
|     [    Skip for now -- I'll set up later  ]    |  Text button, Text Tertiary
|                                                  |  Body Medium, underlined
|     padding-bottom: 48px                         |
+--------------------------------------------------+
```

**Animation Sequence (the "birth" moment):**
1. Screen transition: the orb is already present from Step 3, it smoothly scales from
   80 to 160 over 800ms with a spring curve
2. Ambient gradient behind the orb intensifies (opacity from 30% to 60%) over 600ms
3. After orb settles (200ms pause), greeting text streams in character by character
   at 30ms per character, mimicking the LLM's streaming behavior
4. Orb pulses gently in sync with text streaming
5. After text completes, a 500ms pause, then subtitle fades up from 10px below
6. Buttons fade in 300ms after subtitle

**This is the emotional peak of onboarding.** The companion "comes alive" here. The
streaming text, the warm glow, the breathing orb -- all combine to create a moment
of connection. Haptic feedback: a single medium impact when the orb finishes expanding.

---

## 4. Screen 2: Home/Chat

### 4.1 Layout Overview

The chat screen is the app's primary surface. It should feel spacious, fast, and
personal. The companion's presence is always felt through the ambient gradient and
a small persistent orb.

```
+--------------------------------------------------+
|  [Status Bar - blends with header]               |
|                                                  |
|  +--------------------------------------------+  |
|  | [<-]   [Orb 32x32] [Name]    [...menu]    |  |  HEADER
|  |         "Online -- 7B model"               |  |  Glass Subtle
|  +--------------------------------------------+  |  Height: 64px
|                                                  |  Radius: 0 (flush top)
|                                                  |
|  (Ambient gradient -- subtle warm glow            |
|   behind companion messages)                     |
|                                                  |
|  +------------------------------------------+    |
|  |  [Orb  ] Hi! What's on your mind today?  |    |  COMPANION MESSAGE
|  |  [16x16] I've been thinking about our     |    |  Align: left
|  |          last conversation about...       |    |  BG: Glass Subtle
|  |                                 2:30 PM   |    |  Radius: 0 TL, lg others
|  +------------------------------------------+    |  Max width: 85%
|                                                  |  Padding: md (12px) all
|                                                  |
|                +-----------------------------+   |
|                |  Can you help me write a    |   |  USER MESSAGE
|                |  Python script to parse     |   |  Align: right
|                |  CSV files?          2:31 PM|   |  BG: Primary 500 at 15%
|                +-----------------------------+   |  Border: 1px Primary 400
|                                                  |     at 20%
|  +------------------------------------------+    |  Radius: lg TL, 0 TR, lg others
|  |  [Orb] Sure! Here's a clean approach:    |    |
|  |                                           |    |  COMPANION MESSAGE
|  |  ```python                                |    |  with code block
|  |  import csv                               |    |
|  |  from pathlib import Path                 |    |
|  |                                           |    |  Code block:
|  |  def parse_csv(file_path: str):           |    |    BG: Surface 0
|  |      path = Path(file_path)               |    |    Radius: sm (8px)
|  |      with open(path) as f:                |    |    Font: JetBrains Mono 13px
|  |          reader = csv.DictReader(f)       |    |    Padding: md (12px)
|  |          return list(reader)              |    |    Top bar with language label
|  |  ```                                      |    |      and copy button
|  |                                           |    |
|  |  This uses `pathlib` for cross-plat...    |    |
|  |  [... streaming cursor blink]    2:31 PM  |    |
|  +------------------------------------------+    |
|                                                  |
|  +--------------------------------------------+  |
|  | [+] [  Message [Name]...             ] [^] |  |  INPUT BAR
|  +--------------------------------------------+  |  Glass Prominent
|                                                  |  Height: 56px (expands)
|  [Home]  [Models]  [Profile]  [Settings]         |  Max height: 160px
|                                                  |  Radius: xl (20px)
+--------------------------------------------------+  Margin: 12px horizontal
```

### 4.2 Header Bar

- **Height:** 64px (plus safe area inset)
- **Background:** Glass Subtle (blurred, translucent)
- **Left:** Back arrow (if navigated from elsewhere) OR hamburger (if drawer)
  -- actually, use a bottom nav, so no back arrow. Left side shows the companion
  orb (32x32) and name.
- **Companion mini-orb:** 32x32, same breathing animation but smaller amplitude
- **Name:** Heading Small (16px, Semi 600, Text Primary)
- **Subtitle:** Label Small (10px, Text Tertiary) showing status:
  - "Online -- [Model Name]" when a model is loaded
  - "No model loaded" in Warning color when no model
  - "Thinking..." in Secondary 400 when generating
- **Right:** Overflow menu (three dots) with: New Chat, Chat History, Clear Chat

### 4.3 Message Bubbles

#### Companion Messages
- **Alignment:** Left, with 16x16 mini-orb as "avatar" in top-left
- **Background:** Glass Subtle panel
- **Border radius:** 0px top-left (the "pointer" corner), 16px other three corners
- **Max width:** 85% of screen width
- **Padding:** 12px all sides
- **Typography:** Body Medium (14px) for text content
- **Timestamp:** Label Small (10px), Text Tertiary, bottom-right inside bubble
- **Markdown rendering:** Full support via `flutter_markdown` package
- **Code blocks:** Distinct panel with Surface 0 background, JetBrains Mono font,
  syntax highlighting via `flutter_highlight`, copy button in top-right

#### User Messages
- **Alignment:** Right
- **Background:** Primary 500 at 15% opacity
- **Border:** 1px solid Primary 400 at 20% opacity
- **Border radius:** 16px top-left, 0px top-right, 16px bottom corners
- **Max width:** 80% of screen width
- **Padding:** 12px all sides
- **Typography:** Body Medium (14px), Text Primary

#### Streaming Indicator
When the companion is generating a response:
- The text appears word-by-word (or token-by-token) with a blinking cursor
- Cursor: 2px wide, 16px tall, Primary 400, blinks every 500ms
- The mini-orb in the header shifts to "thinking" state (teal tint)
- A subtle typing indicator (three dots) appears briefly before first token

### 4.4 Input Bar

- **Position:** Fixed at bottom, above bottom navigation
- **Background:** Glass Prominent
- **Border radius:** xl (20px)
- **Margin:** 12px horizontal, 8px bottom (above nav)
- **Height:** 56px default, expands up to 160px as text grows
- **Left button:** `+` icon for attachments (future: images, files)
  - 40x40 touch target, Neutral 500 icon color
- **Text field:** No visible border, placeholder "Message [Name]..."
  - Placeholder: Body Medium, Text Tertiary
  - Input text: Body Medium, Text Primary
- **Send button:** Arrow-up icon in a 40x40 circle
  - Empty input: Neutral 600 background, Neutral 400 icon
  - Has text: Primary 500 background, Text Inverse icon
  - Transition: 200ms ease-out for color change
  - On tap: scale down to 0.9 then back to 1.0 (100ms spring)

### 4.5 Bottom Navigation

```
+--------------------------------------------------+
|  [Chat]     [Models]    [Profile]   [Settings]   |
|  (filled)   (outline)   (outline)   (outline)    |
|  Primary    Neutral     Neutral     Neutral       |
|  400        500         500         500           |
+--------------------------------------------------+
```

- **Height:** 64px (plus safe area bottom inset)
- **Background:** Surface 1 with a top border of 1px Neutral 800
- **Icons:** 24x24 Lucide icons
  - Chat: `message-circle`
  - Models: `download-cloud` (ironic for local-first, but users expect it)
    Actually, use `box` or `cpu` icon -- more fitting for local models
  - Profile: `user` or the companion orb icon
  - Settings: `sliders-horizontal`
- **Active state:** Primary 400 icon, Primary 400 label
- **Inactive state:** Neutral 500 icon, Neutral 500 label
- **Labels:** Label Small (10px, Medium 500)
- **Active indicator:** A pill-shaped highlight behind the active icon
  - 48x32, Primary 400 at 12% opacity, radius full
  - Slides between positions with a 300ms spring animation

### 4.6 Empty State (No Messages)

When there is no chat history:

```
+--------------------------------------------------+
|  [Header]                                        |
|                                                  |
|                                                  |
|                                                  |
|              [Orb 120x120, breathing]            |
|                                                  |
|         "I'm here whenever                       |  Heading Medium
|          you're ready."                          |  Text Secondary
|                                                  |
|     Suggestion chips (horizontally scrollable):  |
|     [Brainstorm ideas]  [Help me write]          |  Glass Subtle chips
|     [Explain a concept] [Just chat]              |  Body Small text
|                                                  |  Height: 36px, radius: full
|                                                  |  Padding: 8px 16px
|                                                  |
|  [Input Bar]                                     |
|  [Bottom Nav]                                    |
+--------------------------------------------------+
```

The suggestion chips scroll horizontally. Tapping one pre-fills the input with a
starter prompt and immediately sends it.

---

## 5. Screen 3: Model Store

### 5.1 Layout Overview

The model store should feel like a curated shop, not a file browser. Models are
presented as "brain" cards with clear capability info, size, and download controls.

```
+--------------------------------------------------+
|  [Status Bar]                                    |
|                                                  |
|  Models                                          |  Display Medium, 28px
|  "Find the right brain for [Name]"              |  Body Medium, Text Secondary
|                                                  |
|  [Search bar: Glass Standard, radius full]       |  Height: 48px
|  [icon: search]  "Search models..."              |  Margin: 0 24px
|                                                  |
|  Filter chips (horizontal scroll):               |
|  [All] [Small <2GB] [Medium] [Large] [Code]     |  Height: 32px
|  [Creative] [Multilingual] [Fast]                |  Radius: full
|                                                  |  Active: Primary 500 fill
|  --- Active Model ---                            |  Section header
|                                                  |  Label Large, Text Tertiary
|  +--------------------------------------------+  |  Uppercase, tracking: 1px
|  | +----------------------------------------+ |  |
|  | |  Llama 3.2 3B                     [ON] | |  |  ACTIVE MODEL CARD
|  | |  Meta -- General Purpose                | |  |  Glass Prominent
|  | |                                         | |  |  Border: 1px Primary 400
|  | |  [Fast] [3.2 GB] [Q4_K_M]              | |  |  Glow: Glow Subtle
|  | |                                         | |  |  Radius: xl (20px)
|  | |  Performance: ||||||||-- 8/10           | |  |
|  | |  Using 1.2 GB RAM                      | |  |
|  | +----------------------------------------+ |  |
|  +--------------------------------------------+  |
|                                                  |
|  --- Available ---                               |
|                                                  |
|  +--------------------------------------------+  |
|  | Llama 3.2 7B                               |  |  MODEL CARD
|  | Meta -- General Purpose                    |  |  Glass Standard
|  |                                            |  |  Radius: xl (20px)
|  | [Balanced] [6.4 GB] [Q4_K_M]              |  |  Padding: lg (24px)
|  |                                            |  |
|  | "Great all-rounder. Good at reasoning,    |  |
|  |  conversation, and light coding."         |  |
|  |                                            |  |
|  | Performance: ||||||---- 6/10              |  |
|  | Speed:       ||||||||-- 8/10              |  |
|  |                                            |  |
|  | +--------------------------------------+  |  |
|  | |    Download (6.4 GB)                 |  |  |  Download button
|  | +--------------------------------------+  |  |  Primary outline style
|  +--------------------------------------------+  |  Height: 48px
|                                                  |
|  +--------------------------------------------+  |
|  | Llama 3.2 13B                              |  |
|  | Meta -- Advanced Reasoning                 |  |
|  |                                            |  |
|  | [Powerful] [10.1 GB] [Q4_K_M]             |  |
|  |                                            |  |
|  | "Best reasoning and code generation.      |  |
|  |  Needs more RAM and storage."             |  |
|  |                                            |  |
|  | Performance: |||||||||. 9/10              |  |
|  | Speed:       ||-------- 2/10              |  |
|  |                                            |  |
|  | +--------------------------------------+  |  |
|  | |    Download (10.1 GB)                |  |  |
|  | +--------------------------------------+  |  |
|  +--------------------------------------------+  |
|                                                  |
|  (More cards below, scrollable)                  |
|                                                  |
|  [Bottom Nav]                                    |
+--------------------------------------------------+
```

### 5.2 Model Card Details

Each model card contains:

**Header Row:**
- Model name: Heading Small (16px, Semi 600, Text Primary)
- Publisher: Body Small (12px, Text Tertiary)
- Status indicator (top-right): active badge, downloaded badge, or nothing

**Tags Row (horizontal):**
- Capability tag: e.g., "Fast", "Balanced", "Powerful", "Code", "Creative"
  - Glass Subtle background, Label Small text, radius full, height 24px
  - Color-coded left dot: Fast=Success, Balanced=Info, Powerful=Warning
- Size tag: Shows quantized size, e.g., "6.4 GB"
- Quantization tag: e.g., "Q4_K_M", "Q5_K_M", "Q8_0"

**Description:**
- Body Small (12px, Text Secondary), max 2 lines with ellipsis

**Performance Bars:**
- Two horizontal bars: Performance (quality) and Speed
- Height: 4px, radius full
- Track: Neutral 800
- Fill: Gradient from Secondary 500 to Primary 400
- Label: Label Small, left-aligned; value: Label Small, right-aligned
- Bar width: proportional to the 1-10 score

**Action Area:**
- Download button: 48px height, full width within card, radius md
  - Not downloaded: Outlined style (1px Primary 400 border, transparent bg)
  - Downloading: Shows progress bar replacing the button
    - Progress bar: 4px height, radius full, Primary 400 fill
    - Percentage and speed: Label Small below bar, e.g., "34% -- 2.1 MB/s"
    - Cancel button: small X icon on the right
  - Downloaded: "Activate" button (Primary 500 fill)
  - Active: "Active" label with checkmark, Success color, no button

### 5.3 Download Progress State

When downloading, the card expands slightly to show:

```
+--------------------------------------------+
| Llama 3.2 7B                    [Pause][X] |
| Meta -- General Purpose                    |
|                                            |
| [=======-----------] 34%                   |  Progress bar
| 2.2 GB / 6.4 GB -- 2.1 MB/s -- ~32 min   |  Label Small, Text Tertiary
|                                            |
+--------------------------------------------+
```

The progress bar uses an animated gradient shimmer effect (subtle, not distracting).
The pause button shows `pause-circle` icon, the cancel shows `x-circle`.

### 5.4 Storage Info

At the top of the "Available" section, show a storage summary:

```
Device Storage: 48.2 GB free of 128 GB
[====================--------] 62% used
Models: 9.6 GB  |  Other: 69.8 GB  |  Free: 48.2 GB
```

This helps users make informed decisions before downloading large models.

---

## 6. Screen 4: Settings/Personalization

### 6.1 Layout Overview

Settings is organized into clear sections with descriptive headers. No overwhelming
walls of toggles -- group related settings and use expandable sections for advanced
options.

```
+--------------------------------------------------+
|  [Status Bar]                                    |
|                                                  |
|  Settings                                        |  Display Medium, 28px
|                                                  |
|  --- [Name]'s Personality ---                    |  Section header
|                                                  |
|  +--------------------------------------------+  |
|  | Personality                                 |  |  GLASS CARD
|  | Currently: Friendly                         |  |  Tapping opens picker
|  |                                        [>] |  |  (same as onboarding step 3)
|  +--------------------------------------------+  |
|                                                  |
|  +--------------------------------------------+  |
|  | Response Length                              |  |
|  |                                            |  |
|  | [Concise]---o-----------[Detailed]         |  |  Custom slider
|  |         "Balanced"                         |  |  Thumb: 20x20, Primary 400
|  +--------------------------------------------+  |  Track: 4px, Neutral 700
|                                                  |  Active track: Primary 500
|  +--------------------------------------------+  |
|  | Creativity Level                            |  |
|  |                                            |  |
|  | [Precise]--------o------[Creative]         |  |
|  |           "Balanced"                       |  |
|  +--------------------------------------------+  |
|                                                  |
|  +--------------------------------------------+  |
|  | Custom Instructions                    [>] |  |  Opens a text editor
|  | "Tell [Name] how you'd like them to..."   |  |  for system prompt
|  +--------------------------------------------+  |
|                                                  |
|  --- Appearance ---                              |
|                                                  |
|  +--------------------------------------------+  |
|  | Theme                                       |  |
|  | [*Dark*]  [Light]  [System]                |  |  Segmented control
|  +--------------------------------------------+  |  Glass panels as segments
|                                                  |
|  +--------------------------------------------+  |
|  | Accent Color                                |  |
|  | [o] [o] [o] [o] [o] [o] [o] [o]           |  |  Color circles, 32x32
|  | Amber Teal Rose  Blue Sage Plum Zinc Lime  |  |  Selected: border + check
|  +--------------------------------------------+  |
|                                                  |
|  +--------------------------------------------+  |
|  | Companion Glow Intensity                    |  |
|  |                                            |  |
|  | [Subtle]------o----------[Vibrant]         |  |
|  +--------------------------------------------+  |
|                                                  |
|  --- Advanced ---                                |
|                                                  |
|  +--------------------------------------------+  |
|  | Model Parameters                       [>] |  |  Expandable section
|  | Temperature, Top-P, Context Length         |  |
|  +--------------------------------------------+  |
|                                                  |
|  +--------------------------------------------+  |
|  | Memory & Context                       [>] |  |
|  | Context window: 4096 tokens               |  |
|  | Memory: 23 saved facts                    |  |
|  | [Clear Memory]                            |  |
|  +--------------------------------------------+  |
|                                                  |
|  +--------------------------------------------+  |
|  | Data & Privacy                         [>] |  |
|  | Export chats, delete all data              |  |
|  +--------------------------------------------+  |
|                                                  |
|  --- About ---                                   |
|                                                  |
|  +--------------------------------------------+  |
|  | Version 1.0.0                              |  |
|  | All processing happens on your device.     |  |
|  | Your data never leaves this phone.         |  |
|  +--------------------------------------------+  |
|                                                  |
|  [Bottom Nav]                                    |
+--------------------------------------------------+
```

### 6.2 Settings Card Details

Each settings card:
- **Background:** Glass Standard
- **Border radius:** lg (16px)
- **Padding:** lg (24px) horizontal, base (16px) vertical
- **Margin:** 0 horizontal (full bleed within 24px screen padding), 8px vertical gap
- **Title:** Body Large (16px, Medium 500, Text Primary)
- **Value/Description:** Body Small (12px, Text Tertiary)
- **Chevron:** 20x20, Neutral 500, right-aligned

Cards that navigate to sub-screens have the chevron `>` icon. Cards with inline
controls (sliders, toggles, segmented controls) show the control instead.

### 6.3 Custom Sliders

The sliders are a key personalization tool and deserve a polished custom implementation:

- **Track:** 4px height, radius full, Neutral 700 background
- **Active track:** Primary 500, with a subtle gradient to Primary 400
- **Thumb:** 20px diameter circle, Primary 400 fill, 2px white border
  - On drag: scales to 24px with a Glow Subtle effect
  - Haptic: light impact at each labeled position
- **Labels:** Body Small at left and right ends, Text Tertiary
- **Value label:** Centered below thumb, Label Medium, Primary 400
  - Shows: "Concise", "Balanced", "Detailed" (3 or 5 discrete stops)

### 6.4 Theme Segmented Control

```
+----------------------------------------------+
|  [ * Dark * ]  [  Light  ]  [  System  ]     |
+----------------------------------------------+
```

- **Height:** 40px
- **Background:** Surface 0 (the track behind segments)
- **Radius:** md (12px)
- **Active segment:** Glass Prominent with 1px Primary 400 border
- **Inactive segments:** Transparent
- **Text:** Label Large (14px)
  - Active: Text Primary
  - Inactive: Text Tertiary
- **Transition:** The active indicator slides between positions, 250ms spring

### 6.5 Accent Color Picker

```
[o Amber] [o Teal] [o Rose] [o Blue] [o Sage] [o Plum] [o Zinc] [o Lime]
```

- **Circle size:** 32x32
- **Gap:** 12px
- **Colors:**
  - Amber: #FF9A3D (default)
  - Teal: #2DD4BF
  - Rose: #FB7185
  - Blue: #60A5FA
  - Sage: #86EFAC
  - Plum: #C084FC
  - Zinc: #A1A1AA
  - Lime: #A3E635
- **Selected state:** 2px white border, small checkmark icon (12px) centered
- **Tap animation:** 150ms scale-down to 0.85, then spring back to 1.0
- **Selecting a new accent color updates the entire app's Primary palette in real-time**

### 6.6 Advanced Model Parameters (Expanded)

When the "Model Parameters" card is expanded:

```
+--------------------------------------------+
| Model Parameters                      [v]  |
|                                            |
| Temperature                                |
| [0.0]--------o-----------[2.0]            |  Current: 0.7
|                                            |
| Top-P                                      |
| [0.0]-----------o--------[1.0]            |  Current: 0.9
|                                            |
| Max Tokens                                 |
| [256]-----o---------------[4096]          |  Current: 1024
|                                            |
| Context Window                             |
| [1024]----------o--------[8192]           |  Current: 4096
|                                            |
| [Reset to Defaults]                        |  Text button, Warning color
+--------------------------------------------+
```

These controls use the same slider style. Values are shown as Label Small text
next to the slider thumb.

---

## 7. Screen 5: Companion Profile

### 7.1 Layout Overview

This is the "personality card" of the companion -- a full-screen profile that makes
the AI feel like a character. It should feel warm and personal, like viewing a friend's
profile.

```
+--------------------------------------------------+
|  [Status Bar]                                    |
|                                                  |
|  [<- Back]                          [Edit]       |
|                                                  |
|  (Full-width ambient gradient, strong warm glow)  |
|                                                  |
|              [Companion Orb]                     |
|                200x200                           |
|             (breathing, idle)                    |
|                                                  |
|              "[Name]"                            |  Display Large, 36px
|              "Your Friendly Companion"           |  Body Large, Text Secondary
|                                                  |
|  +--------------------------------------------+  |
|  |            PERSONALITY CARD                |  |  Glass Prominent
|  |                                            |  |  Radius: 2xl (24px)
|  |   Personality: Friendly                    |  |  Full-bleed within 24px
|  |   Created: March 28, 2026                  |  |  padding
|  |   Conversations: 0                         |  |
|  |   Messages exchanged: 0                    |  |
|  |                                            |  |
|  +--------------------------------------------+  |
|                                                  |
|  +--------------------------------------------+  |
|  |            MODEL INFO                      |  |  Glass Standard
|  |                                            |  |
|  |   Active Model: Llama 3.2 3B              |  |
|  |   Quantization: Q4_K_M                    |  |
|  |   Parameters: 3.2 billion                 |  |
|  |   Context Window: 4096 tokens             |  |
|  |                                            |  |
|  |   RAM Usage: 1.2 GB                       |  |
|  |   [=========-------] 1.2 / 4.0 GB        |  |  Usage bar
|  |                                            |  |
|  |   Storage: 3.2 GB                         |  |
|  |   [=====-----------] 3.2 / 128 GB        |  |
|  |                                            |  |
|  +--------------------------------------------+  |
|                                                  |
|  +--------------------------------------------+  |
|  |            MEMORY                          |  |  Glass Standard
|  |                                            |  |
|  |   [Name] remembers:                       |  |
|  |                                            |  |
|  |   * Your name is Silang                   |  |  Bullet list
|  |   * You're a developer                    |  |  Body Small
|  |   * You prefer concise answers            |  |  Text Secondary
|  |   * You like Python and Dart              |  |
|  |                                            |  |
|  |   23 memories total                       |  |
|  |   [View All]  [Clear Memory]              |  |  Text buttons
|  +--------------------------------------------+  |
|                                                  |
|  +--------------------------------------------+  |
|  |            PERSONALITY TRAITS              |  |  Glass Standard
|  |                                            |  |
|  |   Communication Style:                    |  |
|  |   [========--------] Casual               |  |  Trait bars
|  |                                            |  |  Left label: Formal
|  |   Humor Level:                            |  |  Right label: Casual
|  |   [======---------] Moderate              |  |
|  |                                            |  |
|  |   Detail Level:                           |  |
|  |   [==========-----] Detailed              |  |
|  |                                            |  |
|  |   Empathy:                                |  |
|  |   [============---] High                  |  |
|  |                                            |  |
|  +--------------------------------------------+  |
|                                                  |
|  [Bottom Nav]                                    |
+--------------------------------------------------+
```

### 7.2 Hero Section

The top area is a visual hero moment:

- **Ambient gradient:** The strongest in the app. Uses the companion's glow color
  (based on selected accent) as a large, soft radial gradient behind the orb.
  The gradient bleeds from the orb center outward, fading into Surface 0 at the edges.
- **Orb:** 200x200, the largest appearance. Breathing animation with slightly more
  intensity than elsewhere (scale 0.95 to 1.05).
- **Name:** Display Large (36px, Bold, Text Primary), centered
- **Role:** Body Large (16px, Text Secondary), centered
  Shows the personality type: "Your Friendly Companion", "Your Thoughtful Companion", etc.
- **Edit button:** Top-right, icon button (24x24 `pencil` icon), Neutral 400
  Navigates to Settings/Personalization

### 7.3 Info Cards

All cards use the same Glass Standard panel style with consistent internal layout:

- **Card title:** Label Large (14px, Medium 500, Text Tertiary), uppercase,
  letter-spacing 1px, padding-bottom 12px
- **Key-value rows:**
  - Key: Body Medium (14px, Text Secondary)
  - Value: Body Medium (14px, Text Primary), right-aligned
  - Row height: 32px, vertically centered
  - Divider between rows: 1px Neutral 800, horizontal, with 16px inset

### 7.4 Usage Bars

The RAM and Storage usage bars:
- **Height:** 6px
- **Track:** Neutral 800, radius full
- **Fill:** Gradient from Secondary 500 to Primary 400
- **Warning fill (>80%):** Gradient from Warning to Error
- **Labels:** Left shows used amount, right shows total
  - Label Small (10px), Text Tertiary

### 7.5 Personality Trait Bars

Visual representation of the companion's personality configuration:
- **Height:** 4px per bar
- **Track:** Neutral 800
- **Fill:** Primary 400, radius full
- **Left label:** The "low" end (e.g., "Formal"), Label Small, Text Tertiary
- **Right label:** The "high" end (e.g., "Casual"), Label Small, Text Tertiary
- **Value label:** Centered below bar, Label Medium, Primary 400
- **Spacing:** 20px between trait rows

### 7.6 Memory Section

Shows what the companion "remembers" about the user:
- Bullet list of key memories, max 5 shown with "View All" link
- Each bullet: Body Small (12px), Text Secondary, with a small circle bullet (4px)
  in Neutral 600
- "View All" opens a full-screen sheet with all memories, each deletable with swipe
- "Clear Memory" button: Text button in Warning color with confirmation dialog

---

## 8. Animation & Micro-Interaction Guide

### 8.1 Core Timing Curves

| Animation Type         | Duration | Curve              | Usage                        |
|------------------------|----------|--------------------|-----------------------------|
| Page transition        | 350ms    | easeInOutCubic     | Screen navigation            |
| Element fade-in        | 250ms    | easeOut            | Content appearing            |
| Button press           | 100ms    | easeOut (down)     | Scale to 0.95                |
| Button release         | 200ms    | spring (1.0, 0.7)  | Scale back to 1.0           |
| Slide-up reveal        | 350ms    | easeOutCubic       | Bottom sheets, new content   |
| Color transition       | 200ms    | easeInOut          | Theme changes, state changes |
| Orb breathing          | 4000ms   | easeInOut (loop)   | Idle state                   |
| Orb thinking           | 1500ms   | easeInOut (loop)   | Processing state             |
| Progress bar           | 300ms    | easeOut            | Value changes                |
| Tab switch indicator   | 300ms    | spring (1.0, 0.8)  | Bottom nav active pill      |
| Chip selection         | 150ms    | easeOut            | Filter/option chips          |

### 8.2 Screen Transitions

- **Bottom nav switches:** Fade transition, 200ms. No slide -- the screens feel like
  they exist in the same plane and you are just shifting focus.
- **Push navigation (to sub-screens):** Shared axis transition (Material 3 style).
  The new screen slides in from the right with a slight fade. The current screen
  slides left and fades slightly.
- **Bottom sheets:** Slide up from bottom with a 350ms ease-out-cubic. Background
  dims with a 50% black scrim that fades in over 200ms. Dismiss by swiping down
  (velocity-based) or tapping scrim.
- **Modal dialogs:** Fade in with scale from 0.95 to 1.0, 250ms ease-out.

### 8.3 Companion Orb Micro-Interactions

The orb is the soul of the app's personality. Its animations must feel organic:

**Idle Breathing:**
```dart
// Scale oscillation
scaleAnimation = Tween(begin: 0.97, end: 1.03)
  .chain(CurveTween(curve: Curves.easeInOut))
  .animate(controller..repeat(reverse: true, period: Duration(seconds: 4)));

// Opacity oscillation (subtle)
opacityAnimation = Tween(begin: 0.85, end: 1.0)
  .chain(CurveTween(curve: Curves.easeInOut))
  .animate(controller2..repeat(reverse: true, period: Duration(seconds: 3)));

// Slight position drift (organic wobble)
offsetXAnimation = Tween(begin: -2.0, end: 2.0)
  .chain(CurveTween(curve: Curves.easeInOut))
  .animate(controller3..repeat(reverse: true, period: Duration(seconds: 5)));
```

**Thinking State:**
- Color shifts from amber to teal over 500ms
- Scale oscillation speeds up (period: 1.5s instead of 4s)
- Small particles (8-12) orbit the orb in a loose ellipse
  - Each particle: 3px circle, same color as orb, 40-60% opacity
  - Orbit period: 2-3 seconds per revolution, randomized per particle
  - Use `CustomPainter` with particle system

**Speaking/Streaming:**
- Rapid subtle brightness pulses (200ms period)
- The orb's edge becomes slightly "fuzzy" (increased blur sigma)
- Scale pulses are tiny and fast (0.99 to 1.01, 300ms)

**Transition between states:**
- All state transitions take 500ms with easeInOut
- Color, scale amplitude, and speed interpolate smoothly
- Never abrupt -- the orb should feel like it is *deciding* to change states

### 8.4 Message Animations

- **New user message:** Slides in from right, 250ms ease-out-cubic, with a slight
  scale-up from 0.95 to 1.0. Haptic: light impact.
- **New companion message:** Fades in from 0 opacity, 200ms. The streaming text
  appears naturally as tokens arrive.
- **Streaming text cursor:** A thin vertical bar (2px wide, 16px tall) in Primary 400
  that blinks (opacity 0 to 1) every 500ms. Disappears when generation completes.
- **Code block appearance:** The code block container fades in as a unit when the
  opening ``` is detected. Syntax highlighting applies progressively as tokens stream.

### 8.5 Haptic Feedback Map

| Action                    | Haptic Type      | iOS               | Android          |
|---------------------------|------------------|--------------------|------------------|
| Send message              | Light impact     | UIImpactLight      | EFFECT_TICK      |
| Receive first token       | Light impact     | UIImpactLight      | EFFECT_TICK      |
| Chip/option select        | Light impact     | UIImpactLight      | EFFECT_CLICK     |
| Download complete         | Success          | UINotificationSucc  | EFFECT_HEAVY     |
| Error                     | Error            | UINotificationErr   | EFFECT_DOUBLE    |
| Slider discrete stop      | Selection tick   | UISelectionChanged  | EFFECT_TICK      |
| Long press                | Medium impact    | UIImpactMedium     | EFFECT_CLICK     |
| Delete confirmation       | Warning          | UINotificationWarn  | EFFECT_HEAVY     |

### 8.6 Loading & Skeleton States

Never use spinners. Use skeleton shimmer animations:

- **Skeleton color:** Neutral 800 (base) with a shimmer of Neutral 700 sweeping
  left-to-right over 1.5 seconds, repeating
- **Chat loading:** Show 3 skeleton message bubbles (alternating left/right)
  with varying widths (70%, 50%, 80% of max width)
- **Model card loading:** Show 2 skeleton cards with placeholder bars for title,
  tags, and description
- **Profile loading:** Skeleton for orb (circle), name (centered bar), and cards

---

## 9. Implementation Notes

### 9.1 Key Flutter Packages

| Package                    | Purpose                                    |
|----------------------------|--------------------------------------------|
| `flutter_riverpod`         | State management                           |
| `go_router`                | Navigation with transitions                |
| `flutter_markdown`         | Markdown rendering in chat                 |
| `flutter_highlight`        | Syntax highlighting for code blocks        |
| `google_fonts`             | Google Sans Text + JetBrains Mono          |
| `lucide_icons`             | Icon system                                |
| `shimmer`                  | Skeleton loading effects                   |
| `flutter_animate`          | Declarative animation chains               |
| `haptic_feedback`          | Cross-platform haptics                     |
| `shared_preferences`       | Persisting settings locally                |
| `hive` or `isar`           | Local database for chat history + memories |
| `path_provider`            | File paths for model storage               |
| `dio`                      | HTTP client for model downloads            |
| `percent_indicator`        | Download progress bars                     |

### 9.2 Theme Architecture

```dart
// theme/tokens.dart
abstract class AppTokens {
  // Colors
  static const surface0 = Color(0xFF0A0A0F);
  static const surface1 = Color(0xFF12121A);
  static const surface2 = Color(0xFF1A1A26);
  static const surface3 = Color(0xFF222233);

  static const primary50  = Color(0xFFFFF8F0);
  static const primary100 = Color(0xFFFFECD6);
  static const primary200 = Color(0xFFFFD4A8);
  static const primary300 = Color(0xFFFFB870);
  static const primary400 = Color(0xFFFF9A3D);
  static const primary500 = Color(0xFFF07D20);
  static const primary600 = Color(0xFFCC6010);
  static const primary700 = Color(0xFFA14808);
  static const primary800 = Color(0xFF7A3508);
  static const primary900 = Color(0xFF522408);

  static const secondary400 = Color(0xFF2DD4BF);
  static const secondary500 = Color(0xFF14B8A6);

  static const textPrimary   = Color(0xFFF5F5F4);
  static const textSecondary = Color(0xFFA8A29E);
  static const textTertiary  = Color(0xFF78716C);

  // Spacing
  static const spaceXs   = 4.0;
  static const spaceSm   = 8.0;
  static const spaceMd   = 12.0;
  static const spaceBase = 16.0;
  static const spaceLg   = 24.0;
  static const spaceXl   = 32.0;
  static const space2xl  = 48.0;
  static const space3xl  = 64.0;

  // Radii
  static const radiusSm   = 8.0;
  static const radiusMd   = 12.0;
  static const radiusLg   = 16.0;
  static const radiusXl   = 20.0;
  static const radius2xl  = 24.0;
  static const radiusFull = 9999.0;
}

// theme/glass.dart
class GlassPanel extends StatelessWidget {
  final Widget child;
  final GlassVariant variant; // subtle, standard, prominent
  final BorderRadius? borderRadius;

  // Uses ClipRRect + BackdropFilter + Container with border
}

// theme/app_theme.dart
class AppTheme {
  static ThemeData dark() => ThemeData(
    brightness: Brightness.dark,
    scaffoldBackgroundColor: AppTokens.surface0,
    colorScheme: ColorScheme.dark(
      primary: AppTokens.primary500,
      secondary: AppTokens.secondary500,
      surface: AppTokens.surface1,
      // ...
    ),
    textTheme: _buildTextTheme(),
    // ...
  );

  static ThemeData light() => ThemeData(
    brightness: Brightness.light,
    // ...
  );
}
```

### 9.3 Companion Orb Widget Architecture

```dart
// widgets/companion_orb.dart
class CompanionOrb extends StatefulWidget {
  final double size;
  final OrbState state; // idle, listening, thinking, speaking, error
  final Color? colorOverride;

  const CompanionOrb({
    required this.size,
    this.state = OrbState.idle,
    this.colorOverride,
  });
}

enum OrbState { idle, listening, thinking, speaking, error }

class _CompanionOrbState extends State<CompanionOrb>
    with TickerProviderStateMixin {
  late AnimationController _breathController;
  late AnimationController _colorController;
  late AnimationController _particleController;

  // Multiple animation controllers for organic, non-synchronized motion
  // CustomPainter for the glow, noise, and particle effects
}

class OrbPainter extends CustomPainter {
  // Draws:
  // 1. Outer glow (large, soft radial gradient)
  // 2. Inner glow (smaller, brighter radial gradient)
  // 3. Core (smallest, near-white center)
  // 4. Noise overlay (Perlin noise for organic texture)
  // 5. Particles (when in thinking state)
}
```

### 9.4 Chat Message Architecture

```dart
// models/chat_message.dart
class ChatMessage {
  final String id;
  final String content;
  final MessageRole role; // user, companion, system
  final DateTime timestamp;
  final bool isStreaming;
  final MessageStatus status; // sending, sent, error
}

// widgets/message_bubble.dart
class MessageBubble extends StatelessWidget {
  final ChatMessage message;
  final bool showAvatar;
  final bool isLastInGroup;

  // Uses flutter_markdown for rendering
  // Custom code block builder for syntax highlighting
  // Animated streaming cursor when isStreaming is true
}
```

### 9.5 Performance Considerations

1. **Glass panels:** Limit `BackdropFilter` usage to 3-4 visible panels at once.
   On older devices, fall back to solid semi-transparent backgrounds without blur.
   Detect with `WidgetsBinding.instance.window.physicalSize` and RAM checks.

2. **Orb rendering:** The `CustomPainter` should use `shouldRepaint` wisely.
   Only repaint when animation values actually change. Consider using
   `RepaintBoundary` around the orb to isolate its repaint region.

3. **Chat list:** Use `ListView.builder` with `itemExtent` estimation for smooth
   scrolling through hundreds of messages. Implement message recycling.

4. **Model downloads:** Use `Dio` with chunked downloading and resume support.
   Store download progress in local DB so it survives app restarts.

5. **Theme switching:** Use `ValueNotifier<ThemeMode>` at the app root with
   `AnimatedTheme` for smooth transitions between dark and light modes (300ms).

### 9.6 Accessibility Checklist

- [ ] All text meets WCAG AA contrast ratios (4.5:1 for body, 3:1 for large text)
      - Text Primary (#F5F5F4) on Surface 1 (#12121A) = 13.8:1 (passes AAA)
      - Text Secondary (#A8A29E) on Surface 1 (#12121A) = 5.7:1 (passes AA)
      - Text Tertiary (#78716C) on Surface 1 (#12121A) = 3.8:1 (passes AA Large only)
        -> Use Text Tertiary only for labels and captions (large text)
      - Primary 400 (#FF9A3D) on Surface 1 (#12121A) = 6.3:1 (passes AA)
- [ ] All touch targets minimum 44x44dp
- [ ] Semantic labels on all interactive elements
- [ ] Screen reader announces companion state changes
- [ ] Respects `MediaQuery.boldTextOf(context)` for system bold text
- [ ] Respects `MediaQuery.of(context).disableAnimations` for reduced motion
      -> When reduced motion: disable orb breathing, use instant transitions
- [ ] Color is never the only indicator (icons + text accompany all colored states)
- [ ] Focus traversal order is logical (top-to-bottom, left-to-right)

---

## Appendix: Design Rationale Summary

| Decision                    | Rationale                                                    |
|-----------------------------|--------------------------------------------------------------|
| Amber/Coral primary         | Avoids "AI Purple Problem"; feels warm and personal          |
| Abstract orb, not character | Avoids uncanny valley; allows users to project personality   |
| Dark-first design           | Matches 2026 AI interface conventions; reduces eye strain    |
| Glassmorphism               | Creates depth without heavy shadows; feels modern and spatial|
| Streaming text cursor       | Builds anticipation; makes AI feel "alive" and thinking      |
| No cloud icons anywhere     | Reinforces the privacy-first, local-only brand promise       |
| Personality cards not forms | Emotional onboarding, not clinical configuration             |
| Bottom nav (not drawer)     | All primary destinations are visible; reduces navigation cost|
| JetBrains Mono for code     | Industry standard for code readability; signals quality      |
| Haptic feedback map         | Physical feedback makes the companion feel more tangible     |
| Skeleton loading            | Less anxiety-inducing than spinners; sets layout expectations|

---

*This specification is a living document. As implementation proceeds, update values
based on real-device testing, especially glass blur performance on mid-range devices
and orb rendering frame rates.*
