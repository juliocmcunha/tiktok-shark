# Running outside VS Code / building an executable

## Why does the VS Code terminal hang?

The server has an **interactive console** (it reads the keyboard via `stdin`).
The VS Code integrated terminal sometimes handles that poorly, especially
together with `tsx watch`, which **restarts** the process on every file change.
The fix is always the same: run it in its **own window**, outside VS Code.

You have three paths, from simplest to most "production-ready".

---

## Path A — Run with one click (recommended, simplest)

Doesn't produce an `.exe`, but fully fixes the hang and runs in a separate
window. It uses exactly the Node the project already uses, so it **breaks no
dependencies**.

**Windows:** **double-click** `start.bat`.
**Mac/Linux:** in a terminal, run `chmod +x start.sh` once, then
`./start.sh` (or double-click it, depending on your system).

What the launcher does: installs dependencies (first time only), builds the
TypeScript (`npm run build`) and runs `node dist/server.js` in a dedicated
window — where the `tiktok>` console works without hanging.

> Tip: you can also just open **PowerShell** or **Windows Terminal** (outside
> VS Code), `cd` into the project folder and run `npm run start:ts`. `start:ts`
> runs **without** `watch`, which usually kills the problem on its own.

---

## Path B — A real single-file executable (`.exe`) with Bun

Produces **a single file** that runs even on a PC **without Node installed**.
Great for moving to another computer or just double-clicking.

1. Install **Bun** (once):
   - Windows (PowerShell): `powershell -c "irm bun.sh/install.ps1 | iex"`
   - Mac/Linux: `curl -fsSL https://bun.sh/install | bash`
2. In the project folder, make sure dependencies are present: `bun install`
   (or reuse the `node_modules` that `npm install` already created).
3. Compile to an executable:
   ```bash
   bun build ./server.ts --compile --outfile tiktok-server
   ```
   (On Windows this produces `tiktok-server.exe`.) This is also wired up as
   `npm run exe:bun`.
4. Run it: **double-click** `tiktok-server.exe` (it opens its own console
   window) or `./tiktok-server` in a terminal.

**Important:**
- Keep the **`.env` in the same folder** as the executable — that's where it
  reads `PORT`, `API_SECRET_KEY`, `SIMULATE_ONLY`, etc.
- Bun aims to be Node-compatible. In practice `express`, `dotenv` and the
  console all work. If `tiktok-live-connector` complains about something
  Node-specific during a real live, use **Path A** for the live part and the
  executable for test mode (`SIMULATE_ONLY=true`).

---

## Path C — A single `.js` file (optional, no new runtime)

If you don't want to install Bun but still want **one file** (you'll still need
Node installed to run it), bundle with esbuild:

```bash
npm install          # ensures esbuild (already in devDependencies)
npm run bundle       # produces dist/server.cjs (everything in one file)
node dist/server.cjs # run it
```

Then a `.bat`/shortcut pointing to `node dist\server.cjs` is enough.

> Note: bundling merges all libraries into one file. If esbuild complains about
> some exotic dependency, Path A is the safest.

---

## Distributing to a client (the sales flow)

The program now **configures itself** and **detects the environment**: on first
run (or whenever configuration is missing), it decides how to ask:

- **Windows / macOS (or Linux with a display):** opens a **configuration page
  in the browser** — a visual form with fields and a "Generate key" button.
  This is the friendly path for non-technical clients.
- **Terminal only, no window:** falls back to the **console assistant**
  (questions in the terminal itself).
- **No display and no terminal** (e.g. running as a service): tells you which
  file to edit (`.env`).

In all cases the `.env` is written **next to the executable** and the client
never has to open a file. You can force the mode with the `UI_MODE` variable
(`gui`, `console` or `headless`) if you ever need to.

> Security: the configuration page only accepts connections **from the same
> computer** (loopback). Even with the server exposed via ngrok, no outsider can
> open or change the configuration.

What you hand the client:

- `tiktok-server.exe` (built in Path B).
- (optional) a shortcut / short readme.

What the client does (on Windows/macOS):

1. **Double-clicks** the `.exe`.
2. The browser opens with the form: toggle test mode (or not), type the TikTok
   username, click **Generate** for the key (or type your own), set the port.
3. Clicks **Save and start**. The page shows the **API key** to copy, and the
   server comes up.
4. Later, to change anything, they can reopen the form by typing `setup` in the
   program window, or use `config` / `set TIKTOK_USERNAME anotherchannel`.

> The key shown on the page must match `Config.ApiKey` in Roblox. Tell the
> client to copy it from there (or ship the Roblox place pre-filled).

Because the `.env` lives **next to the `.exe`**, each client has its own
isolated configuration — you can run several copies in different folders without
conflicts.

| Goal                                                 | Path |
| ---------------------------------------------------- | ---- |
| Just stop the hang and run outside VS Code           | **A** |
| A single `.exe` to move to another PC (no Node)      | **B** |
| A single `.js` without installing anything new       | **C** |

In all of them, remember: the **`.env`** must sit next to whatever you run, and
to test without a live use `SIMULATE_ONLY=true` in the `.env`.
