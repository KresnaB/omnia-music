import { GuildPlayer } from './GuildPlayer.js';

export class PlayerManager {
  constructor(deps) {
    this.deps = deps;
    this.players = new Map();
  }

  get(guildId) {
    if (!this.players.has(guildId)) {
      this.players.set(guildId, new GuildPlayer({ ...this.deps, guildId }));
    }

    return this.players.get(guildId);
  }
}
