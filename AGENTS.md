# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the React/TypeScript dashboard: UI in `components/`, WebSocket hooks in `hooks/`, shared helpers in `lib/`, API calls in `api.ts`, and styles in `styles.css`.
- `electron/` implements the desktop shell, local HTTP/WebSocket server, SQLite storage, live capture, and direct-message workflows. Default agent configurations live here too.
- Root Python modules provide the browser-backed API (`live_server.py`), scraper, AI analysis, and configuration validation.
- `.github/workflows/build-desktop.yml` builds installers. Generated frontend assets go to `dist/`; installers go to `release/`. No dedicated test or static-asset directory exists.

## Build, Test, and Development Commands

Use Node.js 24, matching CI, and install dependencies with `npm ci`.

- `npm run dev:desktop`: starts Vite and Electron with the desktop backend.
- `npm run dev`: starts Vite on port 18731 and the Python API on 18732. Requires Python 3.10, FastAPI, Uvicorn, Playwright, and installed Google Chrome; Python dependencies are not managed by npm.
- `npm run dev:web` / `npm run dev:api`: starts either web-mode service separately.
- `npm run build`: runs TypeScript checks and builds frontend assets.
- `npm run desktop`: builds and opens the desktop application.
- `npm run desktop:build:mac` / `npm run desktop:build:win`: builds platform installers.

## Coding Style & Naming Conventions

Follow existing files: two-space indentation, single quotes, and generally no semicolons in TypeScript/JavaScript; four-space indentation and snake_case in Python. Use PascalCase component filenames (`MessageFeed.tsx`), `use`-prefixed hooks, and camelCase JavaScript functions. TypeScript is strict. No ESLint or Prettier tooling is configured. Reuse existing helpers and keep changes focused. Keep nickname normalization and extraction behavior consistent across frontend, Electron, and Python implementations.

## Testing Guidelines

No automated test suite, `npm test` script, or coverage threshold exists. Run `npm run build`, then smoke-test affected workflows: login persistence, room connection/disconnection, streamed messages, AI summaries, history, and direct-message drafts. Verify desktop-specific behavior through `npm run dev:desktop`. Record reproduction steps and validation results in the PR.

## Commit & Pull Request Guidelines

History uses Conventional Commit prefixes such as `feat:`, `fix:`, and `ci:`, usually with concise Chinese descriptions. Keep commits focused. PRs should explain the behavior change, link relevant issues, list validation performed, and include screenshots for UI changes.

## Security & Configuration

Keep API keys, cookies, `.auth/`, databases, capture logs, and generated bundles out of commits. Desktop runtime configuration resides in Electron's user-data directory; root `agent_config.json` configures Python analysis.
