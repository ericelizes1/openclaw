# Molt OpenClaw Fork

This is a fork of [OpenClaw](https://github.com/openclaw/openclaw) maintained for the Molt multi-agent system.

## Branch Structure

```
ericelizes1/openclaw
├── main                          # Tracks upstream/main + our merged features
├── molt-prod                     # Production branch - all features merged
├── feat/discord-webhook-routing  # PR #6835 - Webhook identity for agents
└── feature/broadcast-routing     # WIP - Multi-agent broadcast to shared channels
```

## Workflow

### Adding Features

1. Create feature branch from `upstream/main`:
   ```bash
   git fetch upstream
   git checkout -b feat/my-feature upstream/main
   ```

2. Implement and commit changes

3. Push to origin and create PR to upstream:
   ```bash
   git push origin feat/my-feature
   gh pr create --repo openclaw/openclaw --head ericelizes1:feat/my-feature --base main
   ```

4. Once reviewed (or for immediate use), merge into `molt-prod`:
   ```bash
   git checkout molt-prod
   git merge feat/my-feature
   git push origin molt-prod
   ```

### Syncing with Upstream

```bash
git fetch upstream
git checkout main
git merge upstream/main
git push origin main

# Update molt-prod
git checkout molt-prod
git merge main
git push origin molt-prod
```

### Using molt-prod in Production

Update your system to use the fork:

```bash
# Clone the fork
git clone https://github.com/ericelizes1/openclaw.git
cd openclaw
git checkout molt-prod

# Install and build
pnpm install
pnpm build

# Link globally (or update PATH)
npm link
```

## Current Features

### Discord Webhook Routing (PR #6835)
Routes Discord replies through webhooks for distinct agent identities.

**Config:**
```json
{
  "agents": {
    "list": [
      {
        "id": "seven",
        "discord": {
          "responseWebhook": "https://discord.com/api/webhooks/...",
          "responseWebhookAvatar": "https://example.com/avatar.png"
        }
      }
    ]
  }
}
```

### Broadcast Routing (WIP)
Multiple agents receive messages from shared channels.

## Maintenance

This fork is maintained by Seven (Senior Engineer) for the Molt team.

- **Upstream PRs**: Always attempt to upstream features that could benefit the community
- **Sync frequency**: Sync with upstream weekly or before major work
- **Testing**: Test features on molt-prod before merging
