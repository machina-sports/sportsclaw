/**
 * sportsclaw — Relay Pub/Sub Integration Test
 *
 * Starts the GameMonitor polling ESPN for live NBA games and the
 * GamePresenter listening for relay events. Uses console output only
 * (no Discord/Telegram targets) to verify the end-to-end pipeline.
 *
 * Usage:
 *   npx tsc && node dist/test-relay.js
 */

import { gameMonitor } from "./game-monitor.js";
import { gamePresenter } from "./game-presenter.js";
import { relayManager } from "./relay.js";

async function run() {
  console.log("Starting SportsClaw Relay Pub/Sub Architecture Test...\n");

  // 1. Initialize the presenter (subscribes to relay channel)
  await gamePresenter.initialize();

  // 2. Add a console-only handler to see all events in stdout
  relayManager.onMessage((event) => {
    console.log(
      `\n[Test] Received ${event.event} for ${event.data.gameId}:`,
      `${event.data.away.abbreviation} ${event.data.away.score} @ ` +
        `${event.data.home.abbreviation} ${event.data.home.score}`,
      `(${event.data.statusDetail})`
    );
    if (event.delta) {
      console.log("[Test] Delta:", JSON.stringify(event.delta));
    }
  });

  // 3. Start monitoring NBA (all live games today)
  await gameMonitor.startMonitoring("nba");

  console.log("\nMonitoring NBA games. Press Ctrl+C to stop.\n");

  // Auto-stop after 2 minutes for testing
  setTimeout(() => {
    console.log("\n[Test] 2-minute timeout reached. Shutting down...");
    gameMonitor.stopAll();
    gamePresenter.shutdown();
    relayManager.shutdown().then(() => process.exit(0));
  }, 120_000);

  // Graceful shutdown on Ctrl+C
  process.on("SIGINT", () => {
    console.log("\n[Test] Shutting down...");
    gameMonitor.stopAll();
    gamePresenter.shutdown();
    relayManager.shutdown().then(() => process.exit(0));
  });
}

run().catch(console.error);
