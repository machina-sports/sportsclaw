import { relayManager } from './relay.js';

export class GamePresenter {
  private subscribedGames: Set<string> = new Set();
  
  constructor() {
    relayManager.onMessage((msg) => {
      this.handleMessage(msg);
    });
  }

  async subscribeToGame(gameId: string) {
    if (this.subscribedGames.has(gameId)) return;
    
    await relayManager.initialize();
    
    console.log(`[GamePresenter] Subscribed to updates for game ${gameId}`);
    this.subscribedGames.add(gameId);
  }

  private handleMessage(msg: any) {
    // Only process messages from our live-games channel
    console.log("RX msg.to:", msg.to); if (msg.to !== 'live-games') return;

    try {
      const content = msg.content || msg.text;
      if (!content) return;
      
      const payload = JSON.parse(content);
      if (payload.event === 'GAME_UPDATE' && this.subscribedGames.has(payload.data.gameId)) {
        this.renderDiscordEmbed(payload.data);
        this.renderTelegramInline(payload.data);
      }
    } catch (e) {
      // Parse error or non-JSON message, ignore
    }
  }

  private renderDiscordEmbed(data: any) {
    console.log(`\n[Discord Presenter] 🔄 PATCH Webhook for Game ${data.gameId}`);
    console.log(`   Embed Title: ${data.sport} Live: ${data.score.away} - ${data.score.home}`);
    console.log(`   Embed Fields: [Clock: ${data.clock}] [Spread: ${data.odds.spread}]`);
  }

  private renderTelegramInline(data: any) {
    console.log(`[Telegram Presenter] 🔄 editMessageText for Game ${data.gameId}`);
    console.log(`   Text: 🏀 ${data.sport} | ${data.score.away} - ${data.score.home} | ${data.clock}`);
    console.log(`   Keyboard: [Refresh] [More Odds]\n`);
  }
}

export const gamePresenter = new GamePresenter();
