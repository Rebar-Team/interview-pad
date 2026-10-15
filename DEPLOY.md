# Deploying RebarPad on AWS

Rustpad (collaborative editor) + ptyd (interactive terminal) + Caddy
(auto-HTTPS), on a single EC2 box, with Cloudflare DNS in front.

> **Why a VM and not Fargate / App Runner?** ptyd runs each pad's code in a
> sibling Docker container, so it needs a real Docker host (the docker socket).
> A single small VM is also the cheapest option. No privileged containers or
> cgroup tweaks are required.

The live deployment: **https://interview.withrebar.ai** (AWS account 703,
`us-east-1`, `t3.small`).

---

## 1. Launch the EC2 instance

Use **`scripts/launch-ec2.sh`** — it bakes in the hardened settings (IMDSv2
required, encrypted gp3 root, public subnet) so they can't be forgotten:

```bash
./scripts/launch-ec2.sh            # prints the new instance id
# then associate your Elastic IP:
aws ec2 associate-address --instance-id i-xxxx --allocation-id eipalloc-xxxx
```

What it sets, and why it matters:

- **AMI:** Ubuntu 22.04 LTS, **x86_64** (matches the language images in use).
- **Type:** `t3.small` (2 vCPU / 2 GB) handles 1:1 interviews; `t3.medium`
  builds faster.
- **Disk:** 30 GB gp3, **encrypted**.
- **IMDSv2 required** (`HttpTokens=required`, hop limit 1) — this is a launch-time
  setting, so relaunching *without* the script reintroduces the "EC2 uses
  IMDSv1" finding. Always launch via the script (or pass the same
  `--metadata-options`).
- **Networking:** a **public subnet** (with a `0.0.0.0/0` route to an Internet
  Gateway — not a NAT-only subnet) + an **Elastic IP** so the address survives
  stop/start.
- **Security group (inbound):** TCP `22` (SSH, your IP only), `80` and `443`
  (open to the world — needed for TLS + candidate access).

## 2. Configure and start

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/Rebar-Team/interview-pad.git /opt/interview-pad
cd /opt/interview-pad
sudo ./scripts/setup-host.sh interview.example.com you@example.com
```

`setup-host.sh` installs Docker, generates `.env`, pulls the language images and
builds the TypeScript runtime (`prepare-runtimes.sh`), installs the pull-based
deploy timer, and starts the stack. It's idempotent.

## 3. Cloudflare DNS

In the Cloudflare dashboard for the zone:

1. Add an **A record**: name = your subdomain (e.g. `interview`), value = the
   instance's **Elastic IP**.
2. Set proxy status to **DNS only (grey cloud)** so Caddy can complete the
   Let's Encrypt HTTP-01 challenge and terminate TLS itself.

Browse to `https://<DOMAIN>`; Caddy issues the cert on the first request (~30s).

## 3b. Google sign-in

Interviewers sign in with Google; candidates never do. Create the OAuth client
once in a GCP project owned by the withrebar.ai organization:

1. **APIs & Services -> OAuth consent screen:** user type **Internal**. Google
   then refuses accounts outside the Workspace before they reach us.
2. **Credentials -> Create OAuth client ID -> Web application**, with redirect URIs
   `https://<DOMAIN>/auth/callback` and `http://127.0.0.1:3030/auth/callback`.
3. Put the ID and secret in `/opt/interview-pad/.env` as `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`, then `sudo bash scripts/deploy.sh`.

The server also checks the ID token's `hd` claim and email domain against
`GOOGLE_ALLOWED_DOMAIN`, so an External consent screen would still be safe.
`SESSION_SECRET` (at least 32 characters) signs the 12-hour session cookie.
`setup-host.sh` generates it on new boxes; on an existing box add it yourself:

```bash
echo "SESSION_SECRET=$(openssl rand -hex 32)" | sudo tee -a /opt/interview-pad/.env
```

Rotating it signs everyone out.

**Set these before merging the sign-in change.** `scripts/deploy.sh` refuses to
deploy while `SESSION_SECRET`, `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` is
empty. On that deploy, existing pads become read-only (still readable at
`/r/<id>`; old `/#<id>` links redirect) and only the dashboard creates rooms, so
merge outside interview hours.

## 4. Continuous deployment

`setup-host.sh` installs a systemd timer (`interview-pad-autodeploy.timer`) that
checks `origin/main` every ~60s and redeploys when it moves. So merging to
`main` ships to the box within a minute or two — no secrets, no inbound access.
Watch it with `journalctl -u interview-pad-autodeploy.service -f`.

To deploy by hand: `sudo bash /opt/interview-pad/scripts/deploy.sh`.

## 5. Cost — and how to make it near-free

A `t3.small` 24/7 is ~**$15/mo** + a few dollars of EBS. Interviews are bursty,
so stop the box when idle — you only pay for the disk while stopped:

```bash
aws ec2 stop-instances  --instance-ids i-xxxx   # after interviews
aws ec2 start-instances --instance-ids i-xxxx   # ~30s before the next one
```

The Elastic IP keeps the URL stable across stop/start. A systemd unit
(`interview-pad.service`, installed by the host provisioner) brings the stack up
on boot; named volumes persist pads across restarts.

## 6. Operating it

- **Run an interview:** open `https://<DOMAIN>`, sign in with your withrebar.ai
  Google account, create a room (name it or keep the generated gamertag), and
  send the candidate the room link. Anyone with the link joins and edits live.
- **Read-only after 6 hours:** a room accepts edits, assistant requests and code
  runs for 6 hours after creation (`ROOM_TTL_MINUTES`), then stays viewable
  forever. Rustpad drops edits, the assistant refuses, and Caddy refuses the
  terminal (`/api/pty-auth`); ptyd tears down a live shell when the window ends.
- **Security model:** interviewers authenticate; candidates reach a room by its
  unguessable 12-character URL. Unknown room URLs 404 instead of creating pads.
- **Languages:** pick one in the toolbar; **Run** (or ⌘/Ctrl+Enter) executes it
  in the shared terminal. The terminal is a real shell you can also type into.
- **Backups (optional):** the `rustpad-data` volume holds pad contents and the
  room table (name, creator, lock time); snapshot
  the EBS volume if you need durability.
