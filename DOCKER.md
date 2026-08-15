# Running Nexus-MD in Docker

This guide assumes you've never used Docker before. Docker packages the bot and
everything it needs (Node, ffmpeg) into one container that runs the same way on
any machine — no "works on my computer" problems, and no OneDrive file-lock
issues.

## 1. Install Docker Desktop

- Windows/Mac: download **Docker Desktop** from https://www.docker.com/products/docker-desktop
- Install it, launch it, and wait until the whale icon in the tray says
  "Docker Desktop is running".
- Verify in a terminal:

  ```bash
  docker --version
  docker compose version
  ```

  Both should print a version. If `docker` isn't found, restart your terminal.

## 2. One-time prep

From the project folder (`C:\Users\cnimb\Documents\nexus-md`):

1. Make sure you have a `.env` file (copy `.env.example` to `.env` and edit it).
2. That's it — the `session/` and `data/` folders are created automatically.

## 3. First run (scan the QR)

The very first time, you need to see the QR code to link WhatsApp. Run it
**attached** so the logs (and QR) print to your screen:

```bash
docker compose up --build
```

- `--build` builds the image the first time (takes a few minutes — it downloads
  Node and ffmpeg).
- When it connects, a QR code prints in the terminal.
- On your phone: **WhatsApp → Settings → Linked devices → Link a device**, then
  scan the QR.
- Once you see "Nexus-MD connected", it's working.

Press `Ctrl+C` to stop it.

## 4. Normal run (in the background)

After the first successful link, run it detached so it stays up on its own:

```bash
docker compose up -d
```

`-d` = detached (background). The container restarts automatically if it crashes
or the machine reboots (`restart: unless-stopped`).

Useful commands:

```bash
docker compose logs -f        # watch live logs (Ctrl+C to stop watching)
docker compose ps             # is it running?
docker compose restart        # restart the bot
docker compose down           # stop and remove the container
docker compose up -d --build  # rebuild after you change the code
```

## 5. What persists

Two folders are mounted into the container as **volumes**, so their contents
survive restarts and rebuilds:

| Host folder | Purpose |
| --- | --- |
| `./session` | WhatsApp login (so you don't re-scan the QR every time) |
| `./data`    | The JSON store (`data/nexus.json`) — sudo, filters, warns, etc. |

Everything else lives inside the container and is disposable. To fully reset
(re-link from scratch), stop the bot and delete the `session/` folder.

## 6. Updating the code

When you change a file in `src/`:

```bash
docker compose up -d --build
```

This rebuilds the image with your changes and restarts. (Unlike `npm run dev`,
the container does **not** hot-reload — you rebuild to apply changes.)

## Notes

- The single-instance lock still applies: don't also run `npm run dev` on your
  host while the container is running — that's two instances on one session,
  which corrupts the encryption keys.
- The bot runs with `tsx` (no compile step), so there's nothing to "build" in
  the TypeScript sense — the Docker build just installs dependencies.
