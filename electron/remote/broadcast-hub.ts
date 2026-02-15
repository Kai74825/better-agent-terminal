import { EventEmitter } from 'events'

class BroadcastHub extends EventEmitter {
  broadcast(channel: string, ...args: unknown[]): void {
    this.emit('broadcast', channel, ...args)
  }
}

export const broadcastHub = new BroadcastHub()
