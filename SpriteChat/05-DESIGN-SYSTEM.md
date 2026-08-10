# SpriteChat - Design System (Kawaii/Cute/Modern)

## Design Philosophy

SpriteChat's UI should feel like a warm, friendly space - not a corporate tool. Every element should evoke softness, playfulness, and personality. Think "cozy game UI" meets "modern chat app."

**Principles:**
1. **Soft over sharp** - Round everything, no hard edges
2. **Pastel over saturated** - Gentle colors that don't fatigue
3. **Bouncy over rigid** - Spring animations, not linear
4. **Personality over neutrality** - Every element has character
5. **Breathable over dense** - Generous spacing, let things float

---

## Color Palette

### Primary Colors

```
+----------+----------+----------+----------+----------+
|  Soft    |  Lavender|   Mint   |  Peach   |  Baby    |
|  Pink    |          |          |          |  Blue    |
| #FFB5C5  | #C3B1E1  | #B2DFDB  | #FFDAB9  | #B3D9FF  |
+----------+----------+----------+----------+----------+
```

### Semantic Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `primary` | `#FFB5C5` | Main accent, active states, primary buttons |
| `secondary` | `#C3B1E1` | Secondary actions, tags, badges |
| `accent` | `#B2DFDB` | Success states, online indicators |
| `warmAccent` | `#FFDAB9` | Warnings, highlights |
| `coolAccent` | `#B3D9FF` | Info states, links |
| `background` | `#FFF8F0` | App background (warm white) |
| `surface` | `#FFFFFF` | Cards, panels, elevated surfaces |
| `textPrimary` | `#4A4A4A` | Main text (soft dark, NOT pure black) |
| `textSecondary` | `#8A8A8A` | Subtle text, timestamps, hints |
| `error` | `#FF8A8A` | Error states (soft red) |
| `success` | `#A8E6CF` | Success states (soft green) |
| `divider` | `#F0E8E0` | Subtle dividers |

### Dark Mode (Future)

| Token | Light | Dark |
|-------|-------|------|
| `background` | `#FFF8F0` | `#1A1A2E` |
| `surface` | `#FFFFFF` | `#25253E` |
| `textPrimary` | `#4A4A4A` | `#E8E8E8` |
| `primary` | `#FFB5C5` | `#FF8FAB` (slightly brighter) |

---

## Typography

### Font Families

- **Primary**: **Nunito** - Friendly rounded sans-serif for body text
- **Display**: **Quicksand** - Playful rounded for headings and titles
- Both available via Google Fonts

### Type Scale

| Style | Font | Size | Weight | Usage |
|-------|------|------|--------|-------|
| `displayLarge` | Quicksand | 28px | Bold | Screen titles |
| `displayMedium` | Quicksand | 24px | Bold | Section headers |
| `titleLarge` | Quicksand | 20px | SemiBold | Card titles |
| `titleMedium` | Nunito | 18px | SemiBold | Subtitles |
| `bodyLarge` | Nunito | 16px | Regular | Primary body text |
| `bodyMedium` | Nunito | 14px | Regular | Secondary text |
| `bodySmall` | Nunito | 12px | Regular | Captions, timestamps |
| `labelLarge` | Nunito | 14px | SemiBold | Button text |
| `chatBubble` | Nunito | 15px | Regular | Message content |

---

## Shape Language

### Border Radius

| Element | Radius | Notes |
|---------|--------|-------|
| Cards | 20px | Main content containers |
| Buttons | 16px | Action buttons |
| Input fields | 24px (pill) | Full pill shape |
| Chat bubbles | 18px | With 4px on the pointed corner |
| Avatars | Full circle | Always circular |
| Modals/Dialogs | 24px | Soft floating panels |
| Chips/Tags | 12px | Small rounded pills |

### Elevation & Shadows

No hard borders. Use shadows and background colors for separation:

```
Level 0 (flat):     No shadow (background elements)
Level 1 (subtle):   0 2px 8px rgba(0,0,0,0.04)    - Cards, list items
Level 2 (raised):   0 4px 12px rgba(0,0,0,0.06)    - Floating buttons, active cards
Level 3 (floating): 0 8px 24px rgba(0,0,0,0.08)    - Modals, dropdowns
Level 4 (overlay):  0 12px 32px rgba(0,0,0,0.12)   - Character speech bubbles
```

---

## Component Designs

### Cute Button

```
+---------------------------------------+
|                                       |
|     Send Message                      |  <- Pill shape, primary color
|                                       |  <- Subtle shadow, bouncy on press
+---------------------------------------+

States:
- Default:  Background #FFB5C5, text white, shadow level 2
- Hover:    Background slightly darker, scale 1.02
- Pressed:  Scale 0.96, shadow level 1 (spring bounce back)
- Disabled: Background #F0E8E0, text #8A8A8A
```

### Chat Bubble

```
Sent (right-aligned):            Received (left-aligned):
+-------------------+           +-------------------+
|  Hey! How are     |           |  I'm good! You?   |
|  you doing? :)    |           |                    |
+-------------------+           +-------------------+
              \                /
            #FFB5C5          #FFFFFF
          (primary)        (surface)
```

- Sent bubbles: Primary color, white text, rounded with small tail bottom-right
- Received bubbles: White/surface, dark text, rounded with small tail bottom-left
- Max width: 70% of chat area
- Padding: 12px horizontal, 8px vertical

### Message Input

```
+--+-------------------------------------------+--+
|  |  Type a message...                         |  |
|  |                                            |  |  <- Pill shape
+--+-------------------------------------------+--+
 ^                                              ^
emoji                                         send
button                                       button
```

- Full-width pill shape
- Background: `#F8F4F0` (slightly tinted)
- Send button: Circular, primary color, arrow icon
- Emoji button: Circular, transparent, emoji icon

### Avatar Widget

```
    +------+
   /  :)   \     <- 48px circle
   \       /     <- Soft border: 2px solid primary
    +------+
     Status      <- 12px green dot (online), positioned bottom-right
```

### Cute Card

```
+---------------------------------------+
|                                       |
|  [Avatar]  Username           2:30 PM |
|            Last message preview...    |
|                                       |
+---------------------------------------+
   Shadow level 1, border-radius 20px
   On hover: scale 1.01, shadow level 2
```

---

## Animation Tokens

### Micro-interactions

| Animation | Duration | Curve | Usage |
|-----------|----------|-------|-------|
| Button press | 150ms | `easeOutBack` (overshoot) | Bouncy scale on tap |
| Card hover | 200ms | `easeOut` | Subtle lift |
| Page transition | 300ms | `easeInOut` | Slide + fade |
| Modal appear | 350ms | `elasticOut` | Bouncy scale from center |
| List item appear | 200ms | `easeOutBack` | Staggered slide-up |
| Toast notification | 400ms | `easeOutBack` | Slide in from top |
| Typing indicator | 600ms | `easeInOut` | Three bouncing dots |

### Spring Physics

For bouncy interactions, use spring curves with overshoot:

```dart
// Bouncy button press
CurvedAnimation(
  parent: controller,
  curve: Curves.elasticOut,  // Overshoot then settle
)

// Smooth transitions
CurvedAnimation(
  parent: controller,
  curve: Curves.easeOutCubic,  // Fast start, gentle end
)
```

### Staggered List Animation

Chat list items appear with a staggered delay:

```
Item 1: 0ms delay    -> slide up + fade in
Item 2: 50ms delay   -> slide up + fade in
Item 3: 100ms delay  -> slide up + fade in
Item 4: 150ms delay  -> slide up + fade in
```

---

## Layout Structure

### Main App Layout (Desktop)

```
+------+------------------------------------+
|      |  SpriteChat            [_] [O] [X] |
| SIDE |                                     |
| BAR  |  +-------------------------------+ |
|      |  |                               | |
| Nav  |  |        CONTENT AREA           | |
| +    |  |                               | |
| Chat |  |  (Chat list or Chat detail)   | |
| List |  |                               | |
|      |  |                               | |
|      |  +-------------------------------+ |
| 240px|           Remaining width           |
+------+------------------------------------+
|  CHARACTER ANIMATION LAYER (transparent)   |
|  (Flame GameWidget overlay - full screen)  |
+--------------------------------------------+
```

### Sidebar Design

```
+------------------+
|  [Logo] Sprite   |  <- App name + cute logo
|                  |
|  [Search...]     |  <- Rounded search bar
|                  |
|  CHATS           |  <- Section label
|  +------------+  |
|  |[Av] Alice  |  |  <- Active chat (highlighted)
|  |  Hey there |  |
|  +------------+  |
|  |[Av] Bob    |  |
|  |  See you!  |  |
|  +------------+  |
|  |[Av] Carol  |  |
|  |  Thanks :) |  |
|  +------------+  |
|                  |
|  +---------+     |
|  | [Gear]  |     |  <- Settings button
|  +---------+     |
+------------------+
```

### Chat Detail View

```
+--------------------------------------------+
|  [<] [Avatar] Alice        [call] [more]   |  <- Header
+--------------------------------------------+
|                                            |
|           March 26, 2026                   |  <- Date divider
|                                            |
|  [Av]  Hey! How are you?                   |  <- Received
|        2:30 PM                             |
|                                            |
|              I'm doing great!  [Av]        |  <- Sent
|                        2:31 PM             |
|                                            |
|  [Av]  That's awesome! Want to             |  <- Received
|        grab coffee later?                  |
|        2:32 PM                             |
|                                            |
+--------------------------------------------+
| [emoji] Type a message...          [send]  |  <- Input
+--------------------------------------------+
```

---

## Iconography

Use **rounded** icon style to match the soft design:

- Prefer outline icons over filled (for non-active states)
- Use filled icons for active/selected states
- Icon size: 24px (standard), 20px (compact), 32px (featured)
- Icon color: `textSecondary` for inactive, `primary` for active

Recommended icon set: **Lucide Icons** or **Phosphor Icons** (both have rounded variants)

---

## Accessibility

Despite the cute aesthetic, maintain accessibility:

| Requirement | Implementation |
|------------|----------------|
| Color contrast | All text meets WCAG AA (4.5:1 ratio minimum) |
| Text scaling | Support system font size preferences |
| Animation toggle | Global setting to disable all animations |
| Focus indicators | Visible focus rings on all interactive elements |
| Screen reader | Semantic labels on all buttons and images |
| Keyboard nav | Full keyboard navigation support |
| Reduced motion | Respect system `prefers-reduced-motion` setting |
