# InterviewPad

A self-hosted, real-time collaborative coding-interview tool: a candidate and an
interviewer edit the same buffer live and run the code in-browser across 60+
languages. Cheap to run, no SaaS, no per-seat pricing.

It's two proven open-source pieces glued together:

- **[Rustpad](https://github.com/ekzhang/rustpad)** (MIT) — real-time
  collaborative editor on the Monaco engine (VS Code's editor), backed by a tiny
  Rust server. Provides the shared editing, cursors, and language selection.
- **[Judge0](https://github.com/judge0/judge0)** (MIT) — sandboxed code
  execution for 60+ languages.
- **[Caddy](https://caddyserver.com/)** — automatic HTTPS in front of both.

The glue added here: a **Run** button + **output panel** + **stdin** box wired
from the editor to Judge0 (`rustpad/src/App.tsx`, `OutputPanel.tsx`,
`judge0.ts`), and SQLite persistence so pads survive restarts.

## Layout

```
interview-pad/
├── docker-compose.yml   # rustpad + judge0 (server/workers/db/redis) + caddy
├── Caddyfile            # auto-HTTPS, routes / -> rustpad, /judge0 -> judge0
├── judge0.conf          # Judge0 + Postgres/Redis config (set passwords here)
├── .env.example         # DOMAIN, ACME_EMAIL, EXPIRY_DAYS
├── DEPLOY.md            # AWS EC2 + Cloudflare step-by-step
└── rustpad/             # Rustpad source with the Run/Judge0 integration
```

## Quick start

See **[DEPLOY.md](./DEPLOY.md)** for the full AWS + Cloudflare walkthrough.
Locally (Linux host, or just to build the images):

```bash
cp .env.example .env          # set DOMAIN=localhost for a local poke
# set passwords in judge0.conf
docker compose up -d --build
```

> **Judge0 needs a privileged container + cgroup v1**, so it runs on a plain VM
> (EC2), **not** Fargate/App Runner, and code execution won't work on Docker
> Desktop for Mac/Windows (cgroup v2). The collaborative editor works anywhere;
> only the Run button needs the Linux/cgroup-v1 host. Details in DEPLOY.md.

## How execution works

The frontend POSTs the buffer to `/judge0/submissions?wait=true` (same origin;
Caddy proxies it). Judge0 language IDs are resolved at runtime from
`/judge0/languages` and matched to the editor's language, so the integration
doesn't break when Judge0 versions renumber their languages.
