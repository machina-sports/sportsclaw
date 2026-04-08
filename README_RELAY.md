# SportsClaw Relay Pub/Sub

The Sprint 2 live game architecture now uses `@agent-relay/sdk`.

### Core Flow:
1. `GameMonitor` (`src/game-monitor.ts`) polls the ESPN API. When the score/spread changes, it broadcasts a `GAME_UPDATE` JSON payload to the `#live-games` Relay channel.
2. `GamePresenter` (`src/game-presenter.ts`) listens to `#live-games`.
3. When it catches a delta, it splits the logic:
   - **Discord:** Triggers a `PATCH` webhook to silently update the existing Embed card in-place.
   - **Telegram:** Triggers `editMessageText` to update the inline keyboard message.

### Testing the POC:
```bash
npm run build
node dist/test-relay.js
```
