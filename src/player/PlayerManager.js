import { GuildPlayer } from './GuildPlayer.js';

export class PlayerManager {
  constructor(deps) {
    this.deps = deps;
    this.players = new Map();
  }

  has(guildId) {
    return this.players.has(guildId);
  }

  get(guildId) {
    if (!this.players.has(guildId)) {
      this.players.set(guildId, new GuildPlayer({ ...this.deps, guildId }));
    }

    return this.players.get(guildId);
  }

  getIfExists(guildId) {
    return this.players.get(guildId) || null;
  }
}
