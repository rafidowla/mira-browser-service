# mira-browser-service

Open-source browser automation service for MIRA.
Runs on your machine. MIT licensed.

## Why this exists

MIRA is a digital employee for social media marketing.
This service gives MIRA the ability to read LinkedIn
and other social platforms using a real browser session
running on your machine.

It runs locally so that:
- Your LinkedIn session never leaves your machine
- Every action is logged to a local audit log
- You can read every line of code that runs on your device
- The MIRA hosting company cannot access your accounts

## What it does

- Manages browser contexts for up to MAX_PROFILES profiles
- Executes read actions (feed, profile, comments)
- Logs every action to a local audit log
- Accepts instructions only from localhost

## What it never does

- Accept connections from outside localhost
- Execute any action without a valid MIRA_API_TOKEN
- Publish, comment, or send messages without explicit
  HITL approval from the operator
- Store your LinkedIn credentials

## Setup

```bash
npm install
# CloakBrowser auto-downloads its patched Chromium binary on first launch —
# no separate `playwright install` step is needed.
cp .env.example .env
# Edit .env and set MIRA_API_TOKEN to a random secret
npm run dev
```

### Browser engine — CloakBrowser (free v146)

This service uses [CloakBrowser](https://github.com/CloakHQ/cloakbrowser) — a
Chromium with source-level (C++) fingerprint patches — as its browser engine,
replacing the older JS-level `playwright-extra` + stealth plugin. It's a drop-in
Playwright replacement; the action handlers use the plain Playwright `Page` API
unchanged.

- **Pinned to the free v146 binary.** Free for personal and commercial use when
  run on your own machine/infra. No Pro subscription or license token is
  configured, and none should be added without a founder decision (Pro is
  $19–199/mo; serving third parties needs a separate OEM/SaaS license — see the
  app's `PENDING.md` §1).
- **The wrapper is MIT; the binary is a proprietary EULA** (no modify /
  redistribute / reverse-engineer). We rent the binary; we don't own it.
- **Fingerprint** is owned by CloakBrowser, keyed off a deterministic
  per-`profile_id` seed (`--fingerprint=<seed>`), so a profile's identity is
  stable across restarts. `src/lib/fingerprint.ts` still supplies honest
  context options (viewport/locale/timezone); its `user_agent` is intentionally
  no longer passed — see `src/lib/context.ts`.
- **First live run must be validated** on the throwaway test account before the
  real account (MIRA Canon I-5 / H1.4): confirm the launch options resolve, the
  v146 binary downloads, and reads succeed.

## Configuration

| Variable         | Default | Description                                |
|------------------|---------|--------------------------------------------|
| `PORT`           | `3001`  | Port the service listens on                |
| `MIRA_API_TOKEN` | —       | Shared secret with the MIRA app. Required. |
| `MAX_PROFILES`   | `5`     | Max concurrent browser profiles            |
| `LOG_LEVEL`      | `info`  | Logging verbosity: `debug`, `info`, `warn` |

## Architecture

```
MIRA App (localhost:3000)
        |
        |  REST (localhost only)
        v
mira-browser-service (localhost:3001)
        |
        |  Playwright API
        v
  CloakBrowser (patched Chromium)
  (your LinkedIn session)
```

## Security model

- Binds exclusively to 127.0.0.1 — unreachable from outside your machine
- All requests authenticated via X-MIRA-TOKEN shared secret
- Audit log of every action written locally
- No credentials stored — uses existing browser sessions in sessions/

## License

MIT — see LICENSE
