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

- **AMI:** Ubuntu 22.04 LTS, **x86_64** (matches the language images in use).
- **Type:** `t3.small` (2 vCPU / 2 GB) handles 1:1 interviews. The Rust build
  uses swap (set up by the script); `t3.medium` builds faster if you prefer.
- **Disk:** 30 GB gp3.
- **Networking:** launch in a **public subnet** (one with a `0.0.0.0/0` route to
  an Internet Gateway — not a NAT-only subnet), and attach an **Elastic IP** so
  the address survives stop/start.
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

- **Run an interview:** open `https://<DOMAIN>`, enter your name, copy the invite
  link from the toolbar, send it to the candidate. Anyone with the link joins and
  edits live.
- **Security model:** access is by unguessable pad URL — no accounts. Fine for
  scheduled interviews; not long-term private storage.
- **Languages:** pick one in the toolbar; **Run** (or ⌘/Ctrl+Enter) executes it
  in the shared terminal. The terminal is a real shell you can also type into.
- **Backups (optional):** the `rustpad-data` volume holds pad contents; snapshot
  the EBS volume if you need durability.
