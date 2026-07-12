# Product

## Register

product

## Users

Developers who build software with AI coding agents. They are technical, keyboard-driven, and live in dev tools (editors, terminals, n8n-style builders). Context: authoring, testing, and debugging executable workflow graphs ("Emberflows") that AI agents write instead of raw code.

## Product Purpose

Emberflow is a visual workflow builder and execution engine. AI agents author application logic as typed node graphs; humans review, run, step through, and debug those graphs visually. The builder is the legibility layer over AI-written logic: the graph is the spec, the implementation, and the debugging surface at once. Success: a developer can understand, run, and trust a flow without reading scattered source files.

## Brand Personality

Operational, warm, precise. A serious tool with an ember glow — dense like a terminal, never decorative. Reference: superset-sh/superset desktop app (warm near-black + burnt-orange highlight); n8n for workflow UX patterns (not its visual style).

## Anti-references

- Marketing-SaaS chrome: hero cards, gradients, glassmorphism, oversized empty space.
- n8n's visual style (busy, colorful node icons) — we take its UX patterns only.
- Generic shadcn-gray dashboards with no identity.
- Anything that reads "diagramming tool" (Miro/Figma canvas whiteboard vibes) — this is an operational runtime surface.

## Design Principles

1. **The canvas is the product** — chrome exists to serve the graph; panels stay quiet and collapsible.
2. **Execution state is first-class** — run status, data values, and logs are always one glance away, never buried.
3. **Authoring vs observing are different modes** — structure/config (right panel) and run data (bottom dock) stay separated.
4. **No guessing** — every field is typed, mapped visually, and offered via typeahead; users never type a field name from memory.
5. **Dense but calm** — compact dev-tool density, one accent color, mono for data, sans for chrome.

## Accessibility & Inclusion

Dark theme default; maintain ≥4.5:1 for body text on warm-dark surfaces. Keyboard reachable controls (comboboxes, tabs, dialogs are Radix-based). Respect prefers-reduced-motion for pulse/animation states.
