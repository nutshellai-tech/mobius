---
name: mobius-architecture-draw
description: Analyze a Mobius project repository and generate a single-file HTML/SVG architecture diagram at .imac/generated_figures/arch.html, with optional image fallbacks.
---

# Mobius Architecture Diagram Generator

This is a Mobius built-in Skill. Do not ask the user to install or invoke Codex
Skills, Claude Code Skills, or any assistant-side Memory/Skill system. Use only
the project files and the Mobius context injected into the current Session.

## Goal

Analyze the current project workspace and generate a polished architecture
diagram as a self-contained file:

- Primary output: `.imac/generated_figures/arch.html`
- Optional fallback previews: `.imac/generated_figures/arch.svg`,
  `.imac/generated_figures/arch.png`, or `.imac/generated_figures/arch.jpg`

The HTML file must contain embedded CSS and an embedded SVG diagram. It should
open directly in a browser and should not require any build step, package
install, external JavaScript, CDN, web font, or image generation service.

## Required Workflow

1. Inspect the repository before drawing.
   - Read `README*`, package manifests, config files, backend/frontend entry
     points, extension manifests, and key service/router/component files.
   - Prefer `rg --files`, `find` with bounded depth, and direct file reads.
   - Ignore noisy generated folders such as `.git`, `.imac/flags`,
     `.imac/generated_figures`, `node_modules`, `dist`, `build`, `coverage`,
     `.next`, `.nuxt`, `target`, `vendor`, and large asset directories.

2. Build a concise architecture model.
   - Identify user-facing entry points.
   - Identify frontend modules, backend routes/services, data stores, workers,
     external integrations, queues, caches, and generated artifacts.
   - Group related files into 5-10 meaningful components. Do not draw every
     file.
   - Add the most important data/control flows only. Prefer readable diagrams
     over exhaustive diagrams.

3. Generate `.imac/generated_figures/arch.html`.
   - Create the output directory if it does not exist.
   - Write valid UTF-8 HTML with inline CSS and inline SVG.
   - No `<script>` tags. No remote CSS, fonts, images, iframes, or imports.
   - Use semantic colors by component category.
   - Include a title, timestamp, project summary, legend, architecture SVG, and
     short notes card.
   - The SVG must include arrow markers, labels, and readable text.

4. Verify the output.
   - Confirm the file exists at `.imac/generated_figures/arch.html`.
   - If possible, open or inspect it enough to catch broken tags, blank SVG,
     missing labels, or impossible arrows.
   - If you create an optional raster image, keep `arch.html` as the primary
     output.

5. Finish cleanly.
   - Report the exact output path and a short summary of what the diagram shows.
   - Remove this Session's `running.flag` if the current task instructions ask
     for it.

## Visual Standard

Use a dark technical-report style inspired by modern architecture diagram tools:

- Background: near-black or deep slate.
- Typography: system sans for body; system monospace for component labels and
  file/path hints.
- Layout: header, two-column summary/legend band, large diagram area, compact
  notes section.
- Components: rounded rectangles with subtle borders and category accent colors.
- Flows: curved or orthogonal SVG paths with arrowheads. Use different stroke
  styles for request flow, data flow, file generation, and optional external
  service calls.
- Accessibility: high contrast, no tiny text, no color-only meaning. Every
  category should also have a text label.

Suggested category colors:

- UI / client: blue
- API / backend route: violet
- Service / domain logic: cyan
- Storage / database / files: emerald
- Worker / agent / automation: amber
- External service / network: rose
- Generated output: lime

## HTML Structure

Use this structure as a guide, adapting labels and positions to the project:

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Project Architecture Diagram</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1020;
      --panel: #111827;
      --panel-2: #0f172a;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --line: rgba(148, 163, 184, 0.35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at top left, rgba(59,130,246,.18), transparent 32rem), var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    .page { max-width: 1440px; margin: 0 auto; padding: 32px; }
    .panel {
      border: 1px solid var(--line);
      background: rgba(15, 23, 42, .82);
      border-radius: 16px;
      box-shadow: 0 24px 80px rgba(0, 0, 0, .35);
    }
    .diagram { width: 100%; height: auto; display: block; }
    .mono { font-family: "JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
  </style>
</head>
<body>
  <main class="page">
    <header>...</header>
    <section class="panel">summary and legend...</section>
    <section class="panel">
      <svg class="diagram" viewBox="0 0 1400 900" role="img" aria-label="Architecture diagram">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8"></path>
          </marker>
        </defs>
        <!-- components and flows -->
      </svg>
    </section>
    <section class="panel">notes...</section>
  </main>
</body>
</html>
```

## Diagram Content Rules

- Name components by business role first, then include representative files in
  smaller monospace text.
- Use arrows only for real inferred relationships. If a relationship is
  uncertain, label it as inferred or omit it.
- Put external dependencies outside the main system boundary.
- Put generated outputs such as reports, figures, exported files, or build
  artifacts in a distinct area.
- Keep labels short. Use 2-4 words for main node names and 1-2 representative
  file paths underneath.
- For large monorepos, draw one top-level diagram and add a "Key directories"
  notes card instead of creating an unreadable file map.

## Output Quality Checklist

Before finishing, make sure:

- `.imac/generated_figures/arch.html` exists.
- The file is self-contained and has no `<script>` tag.
- SVG has a non-empty `viewBox` and visible component nodes.
- Component text is readable against the background.
- The diagram contains a clear data/control flow from user entry to backend,
  storage, workers/agents, and generated artifacts when those concepts exist.
- The final response tells the user what was generated and where it was saved.
