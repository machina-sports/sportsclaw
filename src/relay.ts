import { AgentRelay, Models } from '@agent-relay/sdk';

export class RelayManager {
  private relay: AgentRelay | null = null;
  private onMessageCallback: ((msg: any) => void) | null = null;
  private isInitialized = false;
  private broadcastChannel = "live-games";

  constructor() {}

  async initialize() {
    if (this.isInitialized) return;
    // Initialize relay with the channels we care about
    this.relay = new AgentRelay({ channels: [this.broadcastChannel, 'general'] });

    this.relay.onMessageReceived = (msg) => {
      // Ignore presence events
      if (msg.eventId && msg.eventId.includes('presence')) return;
      if (this.onMessageCallback) {
        this.onMessageCallback(msg);
      }
    };

    this.isInitialized = true;
    console.log("[RelayManager] Relay SDK initialized on channels:", [this.broadcastChannel, 'general']);
  }

  onMessage(callback: (msg: any) => void) {
    this.onMessageCallback = callback;
  }

  async broadcastEvent(eventType: string, payload: any) {
    if (!this.relay) await this.initialize();
    
    const message = {
      event: eventType,
      data: payload,
      timestamp: new Date().toISOString()
    };
    
    await this.relay!.system().sendMessage({ 
      to: '#' + this.broadcastChannel, 
      text: JSON.stringify(message) 
    });
  }

  async shutdown() {
    if (this.relay) {
      await this.relay.shutdown();
      this.relay = null;
      this.isInitialized = false;
      console.log("[RelayManager] Relay SDK shut down.");
    }
  }
}

export const relayManager = new RelayManager();
