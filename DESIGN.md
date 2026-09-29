---
version: alpha
name: AidedMind
description: An iPhone-first reading notebook with quiet, warm surfaces and lavender actions.
colors:
  primary: "#c4b6e8"
  background-dark: "#1c1c27"
  surface-dark: "#252532"
  text-dark: "#f0edf5"
  accent-dark: "#c4b6e8"
  background-light: "#f7f4ef"
  surface-light: "#fffdfa"
  text-light: "#312a40"
  accent-light: "#695085"
  danger-dark: "#e9a095"
  danger-light: "#a14238"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, ui-sans-serif, Segoe UI, Roboto, sans-serif"
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, ui-sans-serif, sans-serif"
  reading:
    fontFamily: "ui-serif, New York, Georgia, serif"
rounded:
  DEFAULT: "24px"
  md: "16px"
  sm: "12px"
omitted:
  - section: spacing
    reason: "The existing app uses component-level spacing, safe-area variables, and responsive rules in web/app.css."
components:
  card: {}
  button: {}
  bottom-sheet: {}
  shared-links: {}
---

# AidedMind Design System

## Overview

An iPhone reading notebook: the source and the user's note should feel more important than the machinery behind a breakdown. The audience saves articles and videos while reading in other apps, often quickly and with limited attention. The app is an English-language product surface with a compact phone layout. Its signature is the warm dark and light palette with lavender actions; processing and recovery states should remain calm and literal.

This file records the established visual identity. `web/app.css` owns the runtime tokens under `:root` and the light color-scheme override; change both together for a durable token decision. The interface should not resemble a busy feed or an AI chat transcript.

## Colors

Use the existing dark and light surface, text, accent, and danger tokens above. Lavender denotes the primary action; danger colors signal an item needing attention. Do not use danger styling merely because an item is still queued. The additional graph and source colors remain in `web/app.css`.

## Typography

Use the existing system body and display stacks so controls feel native on iPhone. The serif stack is reserved for reading treatment. State labels and errors use short, plain sentences; visible actions name the operation, such as “Add text.”

## Layout

The app uses a narrow phone-first shell, bottom tabs, cards and grouped rows. Respect the safe-area variables in `web/app.css`. Shared links use the established group-row structure so statuses and actions remain scannable without a separate dashboard.

## Elevation & Depth

Tonal layers and the existing glass navigation treatment create hierarchy. Recovery actions belong in the row that needs them; avoid extra banners for every background retry.

## Shapes

The current CSS variables define 24px containers, 16px medium shapes and 12px small controls. Preserve that grammar for new inbox states.

## Components

Reuse `h`, `openSheet`, `toast`, `setBanner`, group rows and buttons from `web/js/app.js`. A queued item says it is saved and waiting; an unreadable item shows its reason and offers Add text or Remove. A successful edit returns to the same Shared links list. All actions are buttons and remain keyboard and touch accessible. Icons supplement labels rather than replace them. Background movement should communicate work, with reduced-motion behavior inherited from the stylesheet.

## Do's and Don'ts

- Do show that a shared link was saved before AI processing begins.
- Do keep recovery on the same item and preserve its URL.
- Don't imply a paywall teaser is a complete article.
- Don't turn a provider outage into a destructive or alarming screen.
