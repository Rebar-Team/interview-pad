# Deploying InterviewPad on AWS

Rustpad (collaborative editor) + Judge0 (code execution) + Caddy (auto-HTTPS),
on a single EC2 box, with Cloudflare DNS in front.

> **Why EC2 and not Fargate / App Runner?** Judge0's `isolate` sandbox needs a
> **privileged container with cgroup access**. Fargate and App Runner both
> forbid privileged mode, so they can't run Judge0. A single small VM is also
> the cheapest and simplest option here.

---

## 1. Launch the EC2 instance

- **AMI:** Ubuntu 22.04 LTS (x86_64). *Do not use arm64* — Judge0's image is
  x86-only.
- **Type:** `t3.small` (2 vCPU / 2 GB) is enough for 1:1 interviews. Use
  `t3.medium` if you expect several concurrent pads or heavier compiles.
- **Disk:** 20 GB gp3.
- **Security group (inbound):** TCP `22` (SSH, ideally your IP only), `80` and
  `443` (open to the world, needed for TLS + candidate access).

### 1a. Judge0 requires cgroup v1

Judge0 1.13.x needs the legacy cgroup **v1** hierarchy. Ubuntu 22.04 defaults to
cgroup v2, so switch it once and reboot:

```bash
sudo sed -i 's/GRUB_CMDLINE_LINUX="\(.*\)"/GRUB_CMDLINE_LINUX="\1 systemd.unified_cgroup_hierarchy=0"/' /etc/default/grub
sudo update-grub
sudo reboot
```

After reboot, `stat -fc %T /sys/fs/cgroup/` should print `tmpfs` (v1), not
`cgroup2fs`. If you skip this, code runs will hang or return internal errors.

### 1b. Install Docker

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker ubuntu   # log out/in afterwards
```

---

## 2. Configure and start

### Scripted (recommended)

```bash
git clone git@github.com:Rebar-Team/interview-pad.git && cd interview-pad
./scripts/setup-host.sh interview.example.com you@example.com
```

`setup-host.sh` is idempotent. On the first run it applies the cgroup-v1 change
from step 1a and reboots — **just re-run the same command after the reboot** and
it installs Docker, generates the Judge0 secrets, pulls the prebuilt Rustpad
image, and starts everything. (You can skip step 1a/1b if you use the script.)

### Manual

```bash
git clone git@github.com:Rebar-Team/interview-pad.git && cd interview-pad
cp .env.example .env && nano .env       # DOMAIN + ACME_EMAIL
nano judge0.conf                        # set POSTGRES_PASSWORD + REDIS_PASSWORD
docker compose pull rustpad             # prebuilt image from GHCR (fast)
docker compose up -d                    # or: up -d --build to compile locally
```

> **Prebuilt image:** pushes to `main` trigger a GitHub Action that builds and
> publishes `ghcr.io/rebar-team/interview-pad-rustpad:latest`. Make that package
> **public** once (GitHub → org Packages → package → Package settings → change
> visibility) so the box can pull it without a login. Otherwise run
> `docker compose up -d --build` to compile on the box — use a `t3.medium` for
> that, as the Rust build can exceed 2 GB RAM.

First boot pulls images (a minute or two). Watch with `docker compose logs -f`.

---

## 3. Cloudflare DNS

In the Cloudflare dashboard for your zone:

1. Add an **A record**: name = your subdomain (e.g. `interview`), value = the
   EC2 **public IP**.
2. **Set the proxy status to "DNS only" (grey cloud).** This lets Caddy complete
   the Let's Encrypt HTTP-01 challenge and terminate TLS itself — the simplest
   working setup.

Then browse to `https://<DOMAIN>`. Caddy issues the cert automatically on the
first request (give it ~30s). Confirm the whole chain — editor, Judge0, and a
real code run — with:

```bash
./scripts/smoke-test.sh <DOMAIN>
```

<details>
<summary>Alternative: keep Cloudflare proxy on (orange cloud)</summary>

If you want Cloudflare's proxy/DDoS protection, orange-cloud the record and set
the zone SSL mode to **Full (strict)**. Then replace Caddy's automatic cert with
a [Cloudflare Origin Certificate](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/):
mount the origin cert/key into the caddy container and change the `Caddyfile`
site block to `tls /path/cert.pem /path/key.pem`. WebSockets work through the
Cloudflare proxy, so real-time collaboration is unaffected.
</details>

---

## 4. Cost — and how to make it near-free

A `t3.small` running 24/7 is roughly **$15/mo** + a few dollars of EBS. Since
interviews are bursty, **stop the instance when you're not using it** — you only
pay for EBS (~$1.60/mo for 20 GB) while stopped:

```bash
aws ec2 stop-instances  --instance-ids i-xxxx   # after interviews
aws ec2 start-instances --instance-ids i-xxxx   # ~30s before the next one
```

The public IP changes on stop/start unless you attach an **Elastic IP** (free
while the instance is running). Attach one and point the Cloudflare A record at
it so the URL is stable. Docker `restart: always` brings the whole stack back on
boot; SQLite + named volumes persist pads and Judge0 data across stop/start.

---

## 5. Operating it

- **Run an interview:** open `https://<DOMAIN>`, which redirects to a new random
  pad URL (`/#<id>`). Copy the link from the sidebar and send it to the
  candidate. Anyone with the link can join and edit live.
- **Security model:** access is by unguessable URL — there are no accounts. Fine
  for scheduled interviews; don't treat pads as private long-term storage.
- **Languages:** pick the language in the sidebar; the **Run** button (or
  ⌘/Ctrl+Enter) executes via Judge0 and shows stdout/stderr/compile output.
  Non-executable languages (markdown, html, …) disable the Run button.
- **Updating:** `git pull && docker compose up -d --build`.
- **Backups (optional):** the `rustpad-data` and `postgres-data` volumes hold
  pad contents; snapshot the EBS volume if you need durability.
