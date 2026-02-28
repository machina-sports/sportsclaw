import { gameMonitor } from './game-monitor.js';
import { gamePresenter } from './game-presenter.js';

async function run() {
  console.log("Starting SportsClaw Relay Pub/Sub Architecture POC...");
  const gameId = "NBA-100293";
  
  // 1. Presenters subscribe to the game channel
  await gamePresenter.subscribeToGame(gameId);
  
  // 2. Monitor starts polling and broadcasting
  await gameMonitor.startGameMonitor(gameId, "NBA");

  // Let it run for 45 seconds to see a few updates, then shut down
  setTimeout(() => {
    console.log("Stopping POC...");
    gameMonitor.stopGameMonitor(gameId);
    process.exit(0);
  }, 45000);
}

run().catch(console.error);
