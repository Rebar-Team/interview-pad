# RebarPad

A self-hosted, real-time collaborative coding-interview tool by Rebar: a
candidate and an interviewer edit the same buffer live and run code in a shared
**interactive terminal**. Cheap to run, no SaaS, no per-seat pricing. Live at
**https://interview.withrebar.ai**.

Three pieces:

- **[Rustpad](https://github.com/ekzhang/rustpad)** (MIT) — real-time
  collaborative editor on the Monaco engine (VS Code's editor), backed by a tiny
  Rust server. Provides shared editing, cursors, presence, and language
  selection. Rebranded here as RebarPad with a redesigned dark UI.
- **ptyd** — a small Node (`ws` + `node-pty`) service added here. Each pad gets
  one long-lived, sandboxed container running an interactive shell attached to a
  PTY, streamed over WebSocket. The terminal is always typeable; **Run** injects
  the compile/run command for the selected language.
- **[Caddy](https://caddyserver.com/)** — automatic HTTPS in front of both.

**Languages** (interactive, modern versions): Python 3.12, JavaScript (Node 22),
TypeScript (`tsx`), Java (Temurin 21), Go 1.22, C/C++ (gcc 14).

**Why interactive?** Interviews here involve programs that read input live
(Connect-4, Wordle). A batch judge (submit code + fixed stdin) can't do that, so
execution is a real shared shell instead.

## Layout

```
interview-pad/
├── docker-compose.yml   # caddy + rustpad + ptyd
├── Caddyfile            # auto-HTTPS; / -> rustpad, /pty/* -> ptyd (WebSocket)
├── .env.example         # DOMAIN, ACME_EMAIL, EXPIRY_DAYS
├── DEPLOY.md            # AWS EC2 + Cloudflare walkthrough
├── scripts/
│   ├── setup-host.sh        # one-shot EC2 setup (docker, runtimes, up)
│   ├── prepare-runtimes.sh  # pull language images + build the offline TS image
│   ├── deploy.sh            # rebuild + recreate the stack
│   ├── autodeploy.sh        # pull-based CD (run by the systemd timer)
│   └── systemd/             # autodeploy service + timer units
├── ptyd/                # interactive PTY runner (Node + node-pty + docker CLI)
│   └── runtimes/typescript/ # offline tsx runtime image
└── rustpad/             # collaborative editor (Rust + wasm + React/Monaco)
```

## Quick start

See **[DEPLOY.md](./DEPLOY.md)** for the full AWS + Cloudflare walkthrough. On a
Linux host with Docker:

```bash
cp .env.example .env          # set DOMAIN (e.g. interview.example.com) + ACME_EMAIL
./scripts/prepare-runtimes.sh # pull language images + build the TS runtime
docker compose up -d --build
```

> Code execution runs sibling Docker containers, so ptyd mounts the host Docker
> socket and the stack needs a real Docker host (a VM/EC2, not Fargate/App
> Runner). No privileged containers or cgroup tweaks required.

## Rooms and sign-in

`/` is a dashboard for interviewers, behind Google sign-in limited to the
withrebar.ai Workspace (see [DEPLOY.md](DEPLOY.md#3b-google-sign-in)). Creating a
room there is the only way to get one; candidates join at `/r/<roomId>` without
signing in. A room accepts edits, the assistant and code runs for 6 hours after
creation, then becomes read-only for good.

## Local stack

For the local stack with the Rebar Interview Assistant, put `OPENAI_API_KEY` in
the ignored root `.env`, then run:

```bash
docker compose -f compose.local.yaml up -d --build
```

Open `http://127.0.0.1:3030` (use that exact origin, not `localhost`). Only the
gateway publishes a loopback port. Stop any existing preview using port 3030
first. On macOS, choose your working Docker Desktop context if needed. This
configuration does not deploy or change the production Compose stack.

Sign in locally without Google at `http://127.0.0.1:3030/auth/dev` (as
`DEV_LOGIN_EMAIL`). That route exists only when `PUBLIC_ORIGIN` is a loopback
address. Set `ROOM_TTL_MINUTES=2` to watch a room lock.

The assistant runs inside the existing Rust server, with a right-side chat panel
and explicitly approved, undoable code edits. Its key stays server-side. Edit
[`luna.md`](rustpad/rustpad-server/prompts/luna.md) to change its prompt on the
next request. The prompt asks for missing implementation logic rather than
solving, optimizing, or refactoring on the candidate's behalf. See
[assistant details and offline checks](rustpad/rustpad-server/prompts/README.md).

Rooms, pad contents and assistant memory are in-process in this local configuration;
server restarts clear them. The terminal uses the existing Docker-based runner,
which has Docker socket access; submitted programs run in separate non-root,
resource-limited containers without the socket, host files, or assistant key.
Run `scripts/prepare-runtimes.sh` against the same Docker engine to prepare all
languages, including the custom TypeScript runtime. Python was live-verified;
the other language runtimes were not exercised in this change.

## How execution works

The editor opens a WebSocket to `/pty/<padId>` (Caddy proxies it to ptyd). ptyd
starts one sandboxed container per pad running a shell, and streams the PTY both
ways so every participant shares the same terminal. **Run** writes the current
buffer to the pad's volume and injects the run command into the shell.

Each run container is locked down: `--network none`, `--cap-drop ALL`,
`--security-opt no-new-privileges`, non-root, and memory/PID/CPU limits. Good for
interviewing known candidates; it's a lighter sandbox than a hardened judge, not
a defense against hostile actors. Go's build cache persists in the pad's volume
(first Go run ~14s, subsequent ~0.5s).

## Continuous deployment

A systemd timer on the box (`scripts/autodeploy.sh` +
`scripts/systemd/interview-pad-autodeploy.*`) checks `origin/main` every ~60s
and, when it moves, fast-forwards and runs `scripts/deploy.sh`
(`docker compose up -d --build --force-recreate`). So a push to `main` is live
within ~1–2 minutes — no secrets or inbound access required.

## Ops

- **Cost:** runs on one small EC2 box; stop it between interviews to pay only for
  the disk. A systemd unit brings the stack back on boot; volumes persist pads.
- **Sharing:** open the site, set your name, copy the invite link from the
  toolbar. Access is by unguessable pad URL — there are no accounts.
