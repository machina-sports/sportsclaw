/**
 * sportsclaw — Relay Pub/Sub Integration Test (IPTC Schema)
 *
 * Starts the GameMonitor polling ESPN for live NBA games and the
 * GamePresenter listening for relay events. Uses console output only
 * (no Discord/Telegram targets) to verify the end-to-end IPTC pipeline.
 *
 * Usage:
 *   npx tsc && node dist/test-relay.js
 */

import { gameMonitor } from "./game-monitor.js";
import { gamePresenter } from "./game-presenter.js";
import { relayManager, iptcGameId, iptcHome, iptcAway, iptcSportCode, iptcStatus } from "./relay.js";
import type { LiveGameEnvelope } from "./relay.js";

async function run() {
  console.log("Starting SportsClaw Relay Pub/Sub Architecture Test (IPTC Schema)...\n");

  // 1. Initialize the presenter (subscribes to relay channel)
  await gamePresenter.initialize();

  // 2. Add a console-only handler to see all IPTC events in stdout
  relayManager.on("live-games", (envelope: LiveGameEnvelope) => {
    const home = iptcHome(envelope.data);
    const away = iptcAway(envelope.data);
    const gameId = iptcGameId(envelope.data);
    const sportCode = iptcSportCode(envelope.data);
    const status = iptcStatus(envelope.data);

    console.log(
      `\n[Test] Received ${envelope.event} for ${gameId} (${sportCode}):`,
      `${away["sport:code"]} ${away["spstat:score"] ?? 0} @ ` +
        `${home["sport:code"]} ${home["spstat:score"] ?? 0}`,
      `(${envelope.data["sport:statusDetail"]}) [${status}]`
    );

    if (envelope.delta) {
      console.log("[Test] Delta:", JSON.stringify(envelope.delta));
    }

    // Log machina: extensions if present (live-games carries light win probability)
    if (envelope.data["machina:winProbability"]) {
      console.log("[Test] machina:winProbability:", JSON.stringify(envelope.data["machina:winProbability"]));
    }
  });

  // 3. Start monitoring NBA (all live games today)
  await gameMonitor.startMonitoring("nba");

  console.log("\nMonitoring NBA games (IPTC schema). Press Ctrl+C to stop.\n");

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
