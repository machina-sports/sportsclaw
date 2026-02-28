import { relayManager } from './relay.js';

export class GameMonitor {
  private activeGames: Map<string, NodeJS.Timeout> = new Map();

  constructor() {}

  async startGameMonitor(gameId: string, sport: string) {
    if (this.activeGames.has(gameId)) return;
    
    console.log(`[GameMonitor] Starting monitor for ${sport} game ${gameId}`);
    await relayManager.initialize();

    // Mock polling loop simulating live updates
    let homeScore = 0;
    let awayScore = 0;
    
    const interval = setInterval(async () => {
      // Simulate score change
      if (Math.random() > 0.5) homeScore += Math.floor(Math.random() * 3);
      if (Math.random() > 0.5) awayScore += Math.floor(Math.random() * 3);
      
      const payload = {
        gameId,
        sport,
        status: "in_progress",
        score: { home: homeScore, away: awayScore },
        clock: "12:00 Q1",
        odds: { spread: -4.5, total: 221.5 }
      };

      console.log(`[GameMonitor] Broadcasting update: ${homeScore}-${awayScore}`);
      await relayManager.broadcastEvent("GAME_UPDATE", payload);
      
    }, 5000); // 5 seconds for faster POC

    this.activeGames.set(gameId, interval);
  }

  stopGameMonitor(gameId: string) {
    const interval = this.activeGames.get(gameId);
    if (interval) {
      clearInterval(interval);
      this.activeGames.delete(gameId);
      console.log(`[GameMonitor] Stopped monitor for game ${gameId}`);
    }
  }
}

export const gameMonitor = new GameMonitor();
