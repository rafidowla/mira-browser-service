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
npx playwright install chromium
cp .env.example .env
# Edit .env and set MIRA_API_TOKEN to a random secret
npm run dev
```

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
        |  Playwright
        v
  Chromium Browser
  (your LinkedIn session)
```

## Security model

- Binds exclusively to 127.0.0.1 — unreachable from outside your machine
- All requests authenticated via X-MIRA-TOKEN shared secret
- Audit log of every action written locally
- No credentials stored — uses existing browser sessions in sessions/

## License

MIT — see LICENSE
