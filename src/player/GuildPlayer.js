import { spawn } from 'node:child_process';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
  getVoiceConnection,
  joinVoiceChannel
} from '@discordjs/voice';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { formatDuration, nowUnixPlus, truncate } from '../utils/format.js';

function cloneTrack(track) {
  return structuredClone({
    ...track,
    preparedAt: null,
    seekSeconds: 0
  });
}

export class GuildPlayer {
  constructor({ client, guildId, ytdlp, lyrics }) {
    this.client = client;
    this.guildId = guildId;
    this.ytdlp = ytdlp;
    this.lyrics = lyrics;
    this.queue = [];
    this.history = [];
    this.current = null;
    this.currentProcess = null;
    this.currentMessage = null;
    this.playNonce = 0;
    this.loopMode = 'off';
    this.autoplay = false;
    this.preloading = null;
    this.idleTimeout = null;
    this.sleepTimeout = null;
    this.sleepUntil = null;
    this.lastTextChannelId = null;

    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });

    this.player.on(AudioPlayerStatus.Idle, async () => {
      if (this.currentProcess) {
        this.currentProcess.kill('SIGKILL');
        this.currentProcess = null;
      }

      const finished = this.current;
      if (finished) {
        this.handleTrackCompletion(finished);
      }
      await this.playNext('idle');
    });

    this.player.on('error', async (error) => {
      console.error(`[player:${this.guildId}]`, error);
      if (this.currentProcess) {
        this.currentProcess.kill('SIGKILL');
        this.currentProcess = null;
      }
      await this.sendStatusMessage(`Playback error: ${error.message}`);
      await this.playNext('error');
    });
  }

  status() {
    return {
      connected: Boolean(getVoiceConnection(this.guildId)),
      queueSize: this.queue.length,
      paused: this.player.state.status === AudioPlayerStatus.Paused,
      loopMode: this.loopMode,
      autoplay: this.autoplay,
      current: this.current,
      sleepUntil: this.sleepUntil
    };
  }

  async enqueue({ member, textChannel, query }) {
    this.lastTextChannelId = textChannel.id;
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      throw new Error('Kamu harus berada di voice channel terlebih dahulu');
    }

    await this.ensureVoice(voiceChannel);
    const resolved = await this.ytdlp.resolve(query);
    const requester = { id: member.id, name: member.displayName };

    const tracks = resolved.tracks.map((track) => ({
      ...track,
      requester,
      addedAt: Date.now(),
      originalQuery: query
    }));

    this.queue.push(...tracks);

    if (!this.current) {
      void this.playNext('enqueue');
    } else {
      void this.preloadNextTrack();
    }

    return { ...resolved, tracks };
  }

  async ensureVoice(voiceChannel) {
    let connection = getVoiceConnection(this.guildId);

    if (connection) {
      const state = connection.state.status;
      // Jika dalam state Disconnected, coba reconnect dulu
      if (state === VoiceConnectionStatus.Disconnected) {
        const reason = connection.state.reason;
        if (reason === VoiceConnectionDisconnectReason.WebSocketClose && connection.state.closeCode === 4014) {
          // Kicked from channel — buat koneksi baru
          connection.destroy();
          connection = null;
        } else {
          try {
            // Coba rejoin channel yang sama
            await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
          } catch {
            connection.destroy();
            connection = null;
          }
        }
      } else if (state === VoiceConnectionStatus.Destroyed) {
        connection = null;
      }
    }

    if (!connection) {
      connection = joinVoiceChannel({
        guildId: this.guildId,
        channelId: voiceChannel.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
        daveEncryption: true
      });
      connection.subscribe(this.player);

      // Log perubahan state untuk debugging DAVE handshake
      connection.on('stateChange', (oldState, newState) => {
        console.log(`[voice:${this.guildId}] ${oldState.status} → ${newState.status}`);
      });
    }

    try {
      // Timeout 30 detik — DAVE handshake membutuhkan lebih banyak waktu
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    } catch (error) {
      connection.destroy();
      const isAborted = error?.message === 'The operation was aborted';
      throw new Error(
        isAborted
          ? 'Voice connection gagal siap dalam 30 detik. Handshake DAVE/E2EE belum selesai — coba lagi atau hubungi server Discord.'
          : `Voice connection gagal: ${error.message}`
      );
    }

    this.resetIdleTimer();
    return connection;
  }

  resetIdleTimer() {
    clearTimeout(this.idleTimeout);
    this.idleTimeout = setTimeout(() => {
      void this.stop({ disconnect: true });
    }, config.defaultIdleTimeoutMs);
  }

  handleTrackCompletion(track) {
    if (this.loopMode === 'track') {
      this.queue.unshift(cloneTrack(track));
    } else if (this.loopMode === 'queue') {
      this.queue.push(cloneTrack(track));
    }

    track.seekSeconds = 0;
    this.history.push(track);
    if (this.history.length > 25) {
      this.history = this.history.slice(-25);
    }
  }

  async preloadNextTrack() {
    const nextTrack = this.queue[0];
    if (!nextTrack || this.preloading === nextTrack.id) {
      return;
    }

    this.preloading = nextTrack.id;
    try {
      await this.ytdlp.hydrate(nextTrack);
    } catch (error) {
      console.warn(`[player:${this.guildId}] preload failed:`, error.message);
    } finally {
      this.preloading = null;
    }
  }

  async playNext(reason = 'manual') {
    clearTimeout(this.idleTimeout);

    if (this.sleepUntil && Date.now() >= this.sleepUntil) {
      await this.stop({ disconnect: true });
      return;
    }

    if (this.queue.length === 0 && this.autoplay && this.history.length > 0) {
      const last = this.history[this.history.length - 1];
      try {
        const auto = await this.ytdlp.resolve(`${last.title} ${last.uploader} audio`);
        if (auto.tracks[0]) {
          this.queue.push({
            ...auto.tracks[0],
            requester: { id: 'autoplay', name: 'Autoplay' },
            addedAt: Date.now(),
            originalQuery: auto.tracks[0].title
          });
        }
      } catch (error) {
        console.warn(`[player:${this.guildId}] autoplay failed:`, error.message);
      }
    }

    const next = this.queue.shift();
    this.current = next || null;

    if (!next) {
      this.resetIdleTimer();
      return;
    }

    this.playNonce += 1;
    const nonce = this.playNonce;

    await this.ytdlp.hydrate(next);
    const prepared = await this.createAudioPipeline(next);
    if (nonce !== this.playNonce) {
      prepared.process.kill('SIGKILL');
      return;
    }

    if (this.currentProcess) {
      this.currentProcess.kill('SIGKILL');
    }

    this.currentProcess = prepared.process;
    this.player.play(prepared.resource);
    await this.publishNowPlaying(reason);
    void this.preloadNextTrack();
  }

  async createAudioPipeline(track) {
    const args = [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      ...(track.seekSeconds > 0 ? ['-ss', String(track.seekSeconds)] : []),
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '5',
      '-i',
      track.streamUrl,
      '-vn',
      '-map',
      '0:a:0',
      '-c:a',
      'libopus',
      '-b:a',
      '128k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-f',
      'ogg',
      'pipe:1'
    ];

    const process = spawn(config.ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    process.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const probed = await demuxProbe(process.stdout);
    const resource = createAudioResource(probed.stream, {
      inputType: probed.type,
      metadata: track
    });

    process.once('close', (code) => {
      if (code && code !== 0 && stderr.trim()) {
        console.warn(`[player:${this.guildId}] ffmpeg exited with code ${code}: ${truncate(stderr.trim(), 500)}`);
      }
    });

    return { resource, process };
  }

  async publishNowPlaying() {
    if (!this.current || !this.lastTextChannelId) return;
    const channel = await this.client.channels.fetch(this.lastTextChannelId).catch(() => null);
    if (!channel?.isTextBased()) return;

    const embed = this.buildNowPlayingEmbed();
    const components = this.buildControlRows();

    if (this.currentMessage) {
      try {
        this.currentMessage = await this.currentMessage.edit({ embeds: [embed], components });
        return;
      } catch {
        this.currentMessage = null;
      }
    }

    this.currentMessage = await channel.send({ embeds: [embed], components });
  }

  buildNowPlayingEmbed() {
    const status = this.status();
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('Now Playing')
      .setDescription([
        `Durasi: \`${formatDuration(this.current.duration)}\``,
        `Requester: <@${this.current.requester?.id || this.client.user.id}>`,
        `Loop: \`${status.loopMode}\``,
        `Autoplay: \`${status.autoplay}\``
      ].join('\n'))
      .addFields(
        { name: 'Judul', value: truncate(this.current.title, 1024) || 'Unknown' },
        { name: 'Uploader', value: truncate(this.current.uploader || 'Unknown', 1024), inline: true },
        { name: 'Queue', value: String(this.queue.length), inline: true }
      );

    if (this.current.webpageUrl) embed.setURL(this.current.webpageUrl);
    if (this.current.thumbnail) embed.setThumbnail(this.current.thumbnail);
    if (this.current.duration > 0) {
      embed.addFields({
        name: 'Ends',
        value: `<t:${nowUnixPlus((this.current.duration - (this.current.seekSeconds || 0)) * 1000)}:R>`,
        inline: true
      });
    }

    return embed;
  }

  buildControlRows() {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('player:toggle').setLabel('Play/Pause').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('player:skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('player:stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('player:shuffle').setLabel('Shuffle').setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('player:autoplay').setLabel('Autoplay').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('player:loop').setLabel('Loop').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('player:queue').setLabel('Queue').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('player:lyrics').setLabel('Lyrics').setStyle(ButtonStyle.Secondary)
      )
    ];
  }

  async sendStatusMessage(content) {
    if (!this.lastTextChannelId) return;
    const channel = await this.client.channels.fetch(this.lastTextChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      await channel.send({ content: truncate(content, 1900) }).catch(() => null);
    }
  }

  async skip() {
    if (!this.current) throw new Error('Tidak ada lagu yang sedang diputar');
    this.playNonce += 1;
    this.current = null;
    this.player.stop(true);
  }

  async stop({ disconnect = false } = {}) {
    this.queue = [];
    this.current = null;
    this.playNonce += 1;
    clearTimeout(this.sleepTimeout);
    this.sleepUntil = null;
    this.player.stop(true);

    if (this.currentProcess) {
      this.currentProcess.kill('SIGKILL');
      this.currentProcess = null;
    }

    if (disconnect) {
      const connection = getVoiceConnection(this.guildId);
      connection?.destroy();
    }
  }

  togglePause() {
    if (!this.current) throw new Error('Tidak ada lagu yang sedang diputar');
    if (this.player.state.status === AudioPlayerStatus.Paused) {
      this.player.unpause();
      return false;
    }
    this.player.pause();
    return true;
  }

  async seek(seconds) {
    if (!this.current) throw new Error('Tidak ada lagu yang sedang diputar');
    this.current.seekSeconds = Math.max(0, seconds);
    this.queue.unshift(this.current);
    this.current = null;
    this.playNonce += 1;
    this.player.stop(true);
  }

  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    void this.preloadNextTrack();
    return this.queue.length;
  }

  move(from, to) {
    if (from < 1 || from > this.queue.length || to < 1 || to > this.queue.length) {
      throw new Error('Posisi queue tidak valid');
    }

    const [track] = this.queue.splice(from - 1, 1);
    this.queue.splice(to - 1, 0, track);
    void this.preloadNextTrack();
  }

  setLoopMode(mode) {
    this.loopMode = mode;
  }

  nextLoopMode() {
    this.loopMode = this.loopMode === 'off' ? 'track' : this.loopMode === 'track' ? 'queue' : 'off';
    return this.loopMode;
  }

  toggleAutoplay() {
    this.autoplay = !this.autoplay;
    return this.autoplay;
  }

  setSleep(minutes) {
    clearTimeout(this.sleepTimeout);
    const ms = minutes * 60 * 1000;
    this.sleepUntil = Date.now() + ms;
    this.sleepTimeout = setTimeout(() => {
      void this.stop({ disconnect: true });
    }, ms);
    return this.sleepUntil;
  }

  async reconnect(member) {
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) throw new Error('Kamu harus berada di voice channel terlebih dahulu');
    const connection = getVoiceConnection(this.guildId);
    connection?.destroy();
    await this.ensureVoice(voiceChannel);
  }

  async lyricsForCurrent() {
    if (!this.current) throw new Error('Tidak ada lagu yang sedang diputar');
    return this.lyrics.search(this.current.title, this.current.uploader);
  }

  queueLines(limit = 10) {
    const lines = [];
    if (this.current) {
      lines.push(`Sedang diputar: **${this.current.title}**`);
    }
    if (this.queue.length === 0) {
      lines.push('Queue kosong.');
      return lines;
    }
    this.queue.slice(0, limit).forEach((track, index) => {
      lines.push(`${index + 1}. ${track.title}`);
    });
    if (this.queue.length > limit) {
      lines.push(`...dan ${this.queue.length - limit} lagu lain.`);
    }
    return lines;
  }
}
