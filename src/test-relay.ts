/**
 * sportsclaw — Relay Pub/Sub Integration Test (Watch Module)
 *
 * Starts a Watcher polling NBA scoreboard data via the Python bridge and
 * publishes WatchEvents to the relay. Uses console output to verify the
 * end-to-end watch→relay pipeline.
 *
 * Usage:
 *   npx tsc && node dist/test-relay.js
 */

import { WatchManager } from "./watch.js";
import { gamePresenter } from "./game-presenter.js";
import { relayManager } from "./relay.js";
import type { WatchEvent } from "./types.js";

async function run() {
  console.log("Starting sportsclaw Relay Pub/Sub Architecture Test (Watch Module)...\n");

  // 1. Initialize the presenter (subscribes to relay channel)
  await gamePresenter.initialize();

  // 2. Add a console-only handler to see all watch events in stdout
  relayManager.on("watch", (event: WatchEvent) => {
    console.log(
      `\n[Test] WatchEvent ${event.watcherId}: ${event.changesSummary}`,
      `(${event.sport} ${event.command})`
    );
    if (event.changes.length > 0) {
      for (const c of event.changes.slice(0, 5)) {
        console.log(`  ${c.type}: ${c.path}`);
      }
      if (event.changes.length > 5) {
        console.log(`  ... and ${event.changes.length - 5} more`);
      }
    }
  });

  // 3. Start watching NBA scoreboard
  const manager = new WatchManager();
  manager.addWatcher({
    sport: "nba",
    command: "get_scoreboard",
    intervalSeconds: 30,
    output: "relay",
    channel: "watch",
  });

  console.log("\nWatching NBA scoreboard. Press Ctrl+C to stop.\n");

  // Auto-stop after 2 minutes for testing
  setTimeout(async () => {
    console.log("\n[Test] 2-minute timeout reached. Shutting down...");
    await manager.stopAll();
    gamePresenter.shutdown();
    await relayManager.shutdown();
    process.exit(0);
  }, 120_000);

  // Graceful shutdown on Ctrl+C
  process.on("SIGINT", async () => {
    console.log("\n[Test] Shutting down...");
    await manager.stopAll();
    gamePresenter.shutdown();
    await relayManager.shutdown();
    process.exit(0);
  });
}

run().catch(console.error);
