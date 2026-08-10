# Lectures

Long-form technical documentation, rendered as a single self-contained web page.

**Live:** https://lineaix.com

## What's here

| Collection | Contents |
|---|---|
| **DevOps** | A 12-module curriculum taking you from zero operations knowledge to production Kubernetes, applied throughout to one Laravel project (TicketHub) |
| **SpriteChat** | Design and architecture specification for an animated AI messaging app |
| **Governance** | The ORCH multi-agent orchestration system — setup and operation |
| **Other** | Portable AI companion UI/UX specification |

## The viewer

`build-viewer.mjs` converts every `.md` file in this repository into one static HTML page — no server, no CDN, no network at runtime. Markdown is rendered at build time rather than in the browser, so the result opens straight from the filesystem.

```bash
node build-viewer.mjs      # writes index.html
```

Zero dependencies; any Node 18+ will do. Without Node installed:

```bash
docker run --rm -v "$PWD":/w -w /w node:22-alpine node build-viewer.mjs
```

Features: two-level collapsible navigation, per-document section outlines with scroll tracking, full-text filtering over titles and headings, copy buttons on every code block, light/dark/auto themes, deep links (`#/doc-id/section-id`), and a print stylesheet.

Documents that use severity ratings (`— CRITICAL`, `— HIGH`, …) additionally get severity chips, a sidebar legend, and a filter that narrows the page to sections at a chosen level.

## Adding documents

Drop `.md` files anywhere in the tree and rebuild. Folders become collections; nested folders become subgroups, labelled from their `README.md` title where one exists.

Loose files at the root are grouped by filename via `ROOT_COLLECTIONS` near the top of `build-viewer.mjs` — add a rule there when starting a new set.

## Not in this repository

Operational notes for a specific server are kept out deliberately — see `.gitignore`. They contain live infrastructure detail and a personal IP address, and nothing in a public build should depend on them.
