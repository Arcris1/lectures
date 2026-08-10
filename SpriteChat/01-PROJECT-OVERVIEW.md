# SpriteChat - Project Overview

## What is SpriteChat?

SpriteChat is a desktop messaging application where messages are delivered by cute 2D sprite characters that physically run across users' screens. Instead of boring notification popups, animated chibi characters sprint in, deliver messages with speech bubbles, and exit - creating a delightful, game-like communication experience.

## Core Concept

When **PC1** sends a message to **PC3**, and **PC2** is in between:

1. On **PC2's screen**: A character enters from the left, runs to the center, sits down and rests for a moment, then continues running and exits to the right
2. On **PC3's screen**: The character enters from the left, runs to the chat area, shows a speech bubble with the message, waves, and exits

This creates the illusion of a character physically traveling between computers to deliver messages.

## Key Differentiators

- **Animated delivery system** - Messages aren't just received, they're *delivered* by characters
- **AI-powered behavior** - Characters change speed, mood, and animation based on message sentiment
- **Pass-through routing** - Characters visibly travel through relay users' screens
- **Personality system** - Each user has their own character with unique traits
- **Desktop companion** - Characters idle on screen between messages, performing cute random actions

## Target Platform

- **Primary**: Windows Desktop (Flutter Desktop)
- **Future**: macOS, Linux, Mobile (Flutter cross-platform)

## Product Vision

"Discord + Tamagotchi + AI" - A messaging app where communication feels alive, personal, and fun. The character delivery system transforms routine messaging into an engaging experience with viral potential.

## Project Status

- **Started**: March 26, 2026
- **Current Phase**: Phase 1 (Foundation)
- **Location**: `SpriteChat/` in the development workspace
