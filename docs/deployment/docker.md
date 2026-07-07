# Docker

Package sportsclaw — the engine and the sports data layer — into a single container, ready to
run a bot anywhere.

## Build and run

```bash
npm run docker:build      # build the image
npm run docker:run        # run it with your .env file
```

The image bundles both the Node engine and the Python data layer, so the container is
self-contained.

## Configuration

Pass your credentials and bot tokens with an env file:

```bash
docker run --rm --env-file .env sportsclaw
```

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `AZURE_FOUNDRY_API_KEY` | Your model provider |
| `AZURE_FOUNDRY_BASE_URL` / `AZURE_FOUNDRY_IMAGE_BASE_URL` | Azure Foundry text/image endpoints when using `provider=azure-foundry` |
| `DISCORD_BOT_TOKEN` | Run a Discord bot |
| `TELEGRAM_BOT_TOKEN` | Run a Telegram bot |

## Persisting settings

sportsclaw stores config, installed sports, and subscriptions under `~/.sportsclaw`. Mount a
volume there if you want that state to survive container restarts:

```bash
docker run --rm --env-file .env -v sportsclaw-data:/root/.sportsclaw sportsclaw
```
