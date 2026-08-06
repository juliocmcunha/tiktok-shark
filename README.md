# TikTok LIVE → Roblox Bridge

An intermediary server that captures TikTok LIVE events (gifts, likes, chat) and
delivers them to a Roblox game via HTTP polling.

```
[TikTok LIVE] → [Node.js server] ← HTTP polling ← [Roblox]
```

## Requirements

- Node.js **18+** (20 or 22 recommended)
- (optional) **Bun** — only needed to build the single-file `.exe`

## Installation

```bash
git clone <YOUR-REPO-URL>
cd tiktok-roblox-bridge
npm install
```

## Configuration

On first run the program **configures itself**, detecting the environment:

- **Windows / macOS:** opens a **browser** page (visual form).
- **Terminal only:** asks in the **console**.

It prompts for the TikTok username, the API key (it can **generate one for you**),
the port, and whether to run in test mode, then writes the `.env` **next to the
executable**. No manual file editing required.

Prefer to configure by hand? Copy the example and edit it:

```bash
cp .env.example .env
# set TIKTOK_USERNAME and API_SECRET_KEY
```

## Running

```bash
# development (reloads on save)
npm run dev

# production (build, then run)
npm run build
npm start

# type-check only, without running
npm run typecheck
```

## Building the executable (.exe)

With **Bun** installed:

```bash
npm run exe:bun
```

Produces `tiktok-server` (or `tiktok-server.exe` on Windows): a single binary that
runs **without Node**. The `.env` lives in the same folder as the executable.
Alternatives and details in [`BUILDING.md`](./BUILDING.md).

## Test mode (no live needed)

Enable test mode in the configuration (or `SIMULATE_ONLY=true`) and generate events
from the console — they go into the same queue Roblox reads:

```
gift Rose 5 1 @someuser
like 50
chat @another let's go!
```

Handy commands: `config`, `set <key> <value>`, `setup`, `status`, `help`.

## Connecting Roblox

Roblox **cannot reach `localhost`** — expose the server (e.g. `ngrok http 3000`)
and set the following in `roblox/Config.luau`:

- `ServerUrl` = the server's public URL
- `ApiKey` = the same `API_SECRET_KEY` as the server

Full walkthrough (script placement, enabling HTTP in Studio, etc.) in
[`roblox/TUTORIAL.md`](./roblox/TUTORIAL.md).

## Project structure

| File            | Role                                          |
| --------------- | --------------------------------------------- |
| `config.ts`     | configuration + environment detection         |
| `events.ts`     | event queue + emitters                         |
| `tiktok.ts`     | live connection + auto-reconnect               |
| `assistant.ts`  | setup assistant (visual/console)               |
| `server.ts`     | HTTP API + test console + `main()`             |
| `roblox/`       | the game (Luau) and its tutorial               |
