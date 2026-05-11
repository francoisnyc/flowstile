---
title: UI Direction
description: Frontend stack, visual tone, and interaction principles for Flowstile v1.
---

# Flowstile UI Direction

This note defines the frontend stack, visual tone, and interaction principles for Flowstile v1. It is intentionally short. The goal is to make early UI decisions explicit before implementation spreads ad hoc patterns through the codebase.

## Frontend Stack

Flowstile should use:

- `React + Vite` for the application shell
- `Tailwind CSS` for styling
- `shadcn/ui` or `Radix` selectively for low-level interactive primitives
- thin in-house components for the product-specific surfaces

Tailwind is the styling base, not the design system. Product identity should come from Flowstile's own layout, hierarchy, spacing, states, and component composition rather than from a third-party starter aesthetic.

## Product Surfaces

The main UI surfaces are:

- task inbox
- form designer
- auth shell
- admin and configuration views

These should feel like parts of the same product, but not all with the same weight.

The task inbox is the primary operational surface. The form designer should feel slightly more tool-like and editor-oriented. Admin and configuration views should feel stable, restrained, and predictable.

## Visual Tone

Flowstile should feel:

- quiet
- operational
- dense but readable
- trustworthy
- work-focused

This is not a marketing site, a glossy analytics dashboard, or a playful low-code canvas. The interface should support scanning, triage, repeated action, and careful data entry.

## Interaction Principles

### Task Inbox

The inbox should optimize for speed and clarity:

- task status, assignee, priority, and due date should be easy to scan
- list and detail views should feel connected, not like separate pages pretending to be a workflow
- the active task should be obvious
- common actions should be visible without clutter

### Form Designer

The form designer should optimize for precision:

- schema editing should feel structured and tool-like
- preview should stay close to the authored definition
- version state should be clear
- role and visibility behavior should be inspectable without guesswork

### Admin Views

Admin surfaces should optimize for predictability:

- stable layouts
- familiar controls
- minimal visual flourish
- obvious hierarchy between read-only metadata and editable configuration

## Component Strategy

Use libraries for primitives, not for product personality.

Good candidates for third-party primitives:

- dialog
- popover
- dropdown menu
- tabs
- tooltip
- checkbox
- radio group
- switch

Flowstile-specific components should be owned locally:

- inbox shell
- task list row
- task detail header
- priority badge
- assignee display
- form section framing
- role visibility preview controls

## What To Avoid

Avoid:

- generic Tailwind starter-app look
- heavy prebuilt admin-theme styling
- oversized cards as the default layout primitive
- decorative dashboard chrome that competes with task and form content
- inconsistent visual language between inbox, designer, and admin views

## Working Direction

The default direction for v1 is:

- `Tailwind` for styling
- `shadcn/ui` or `Radix` selectively for primitives
- thin in-house components for product surfaces
- quiet operational tone overall
- slightly more tool-like treatment in the form designer

This note should guide early UI implementation until a fuller design system or UI plan is written.
