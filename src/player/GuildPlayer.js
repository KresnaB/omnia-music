import { spawn } from 'node:child_process';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  StreamType,
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
    this.lyricMessages = [];
    this.consecutiveErrors = 0;
    this.skipRequested = false;
    this.stopRequested = false;
    this.autoplayPreparePromise = null;
    this.autoplaySeedId = null;

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
      const wasSkipped = this.skipRequested;
      const wasStopped = this.stopRequested;
      this.skipRequested = false;
      this.stopRequested = false;
      if (finished) {
        this.consecutiveErrors = 0;
        if (wasStopped) {
          finished.seekSeconds = 0;
        } else if (wasSkipped) {
          finished.seekSeconds = 0;
          this.history.push(finished);
          if (this.history.length > 25) {
            this.history = this.history.slice(-25);
          }
        } else {
          this.handleTrackCompletion(finished);
        }
      }
      this.current = null;
      if (wasStopped) {
        this.resetIdleTimer();
        return;
      }
      void this.playNext('idle');
    });

    this.player.on('error', async (error) => {
      console.error(`[player:${this.guildId}]`, error);
      if (this.currentProcess) {
        this.currentProcess.kill('SIGKILL');
        this.currentProcess = null;
      }
      
      this.consecutiveErrors++;
      if (this.consecutiveErrors < 3) {
        await this.sendStatusMessage(`Playback error: ${error.message}. Mencoba lagu berikutnya...`);
        void this.playNext('error');
      } else {
        await this.sendStatusMessage(`Terlalu banyak error berturut-turut. Playback dihentikan.`);
        await this.stop();
      }
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

    // Jalankan join voice + resolve metadata secara paralel (hemat 2-4 detik)
    const [, resolved] = await Promise.all([
      this.ensureVoice(voiceChannel),
      this.ytdlp.resolve(query)
    ]);
    const requester = { id: member.id, name: member.displayName };

    const tracks = resolved.tracks.map((track) => ({
      ...track,
      requester,
      addedAt: Date.now(),
      originalQuery: query
    }));

    if (resolved.type === 'playlist' && tracks[0]) {
      try {
        await this.ytdlp.hydrate(tracks[0]);
      } catch (error) {
        console.warn(`[player:${this.guildId}] first playlist track pre-hydrate failed:`, error.message);
      }
    }

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

  addLyricMessage(msg) {
    if (msg) this.lyricMessages.push(msg);
  }

  clearLyricMessages() {
    for (const msg of this.lyricMessages) {
      msg.delete().catch(() => null);
    }
    this.lyricMessages = [];
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

  async prepareAutoplayTrack() {
    const seed = this.current || this.history[this.history.length - 1];
    if (!this.autoplay || !seed) {
      return;
    }

    if (this.queue.length > 0) {
      await this.preloadNextTrack();
      return;
    }

    if (this.autoplayPreparePromise && this.autoplaySeedId === seed.id) {
      await this.autoplayPreparePromise;
      return;
    }

    this.autoplaySeedId = seed.id;
    this.autoplayPreparePromise = (async () => {
      try {
        let query;
        if (seed.source === 'youtube' && seed.id && seed.id.length === 11) {
          query = `https://www.youtube.com/watch?v=${seed.id}&list=RD${seed.id}`;
        } else {
          query = `ytsearch5:${seed.uploader || seed.title} best hits audio`;
        }

        const auto = await this.ytdlp.resolve(query);
        const candidates = auto.tracks.filter((t) => t.id !== seed.id && !this.history.some((h) => h.id === t.id));
        const chosen = candidates.length > 0
          ? candidates[Math.floor(Math.random() * Math.min(candidates.length, 5))]
          : auto.tracks[0];

        if (!chosen) {
          return;
        }

        const prepared = {
          ...chosen,
          requester: { id: 'autoplay', name: 'Autoplay' },
          addedAt: Date.now(),
          originalQuery: 'Autoplay Suggestion'
        };

        await this.ytdlp.hydrate(prepared);

        const existsInQueue = this.queue.some((track) => track.id === prepared.id);
        const existsInHistory = this.history.some((track) => track.id === prepared.id);
        const isCurrent = this.current?.id === prepared.id;

        if (!existsInQueue && !existsInHistory && !isCurrent) {
          this.queue.push(prepared);
        }
      } catch (error) {
        console.warn(`[player:${this.guildId}] autoplay prepare failed:`, error.message);
      } finally {
        this.autoplayPreparePromise = null;
      }
    })();

    await this.autoplayPreparePromise;
  }

  async playNext(reason = 'manual') {
    clearTimeout(this.idleTimeout);

    if (this.sleepUntil && Date.now() >= this.sleepUntil) {
      await this.stop({ disconnect: true });
      return;
    }

    if (this.queue.length === 0 && this.autoplay) {
      await this.prepareAutoplayTrack();
    }

    const next = this.queue.shift();
    this.current = next || null;

    if (!next) {
      this.resetIdleTimer();
      return;
    }

    this.playNonce += 1;
    const nonce = this.playNonce;

    try {
      await this.ytdlp.hydrate(next);
      const prepared = await this.createAudioPipeline(next);

      if (nonce !== this.playNonce) {
        prepared.process.kill('SIGKILL');
        return;
      }

      if (this.currentProcess) {
        this.currentProcess.kill('SIGKILL');
      }

      this.clearLyricMessages();
      this.currentProcess = prepared.process;
      this.player.play(prepared.resource);
      await this.publishNowPlaying(reason);
      void this.preloadNextTrack();
      void this.prepareAutoplayTrack();
    } catch (error) {
      console.error(`[player:${this.guildId}] playNext failed:`, error.message);
      this.consecutiveErrors++;

      if (this.consecutiveErrors < 3) {
        await this.sendStatusMessage(`Gagal memutar "${next.title}": ${error.message}. Melewati...`);
        // Tunggu sebentar sebelum skip otomatis untuk menghindari spam API gila-gilaan
        await new Promise(r => setTimeout(r, 1500));
        return this.playNext('fallback');
      } else {
        await this.sendStatusMessage(`❌ Terjadi kesalahan berulang (${this.consecutiveErrors}x). Menghentikan playback.`);
        await this.stop();
      }
    }
  }

  async createAudioPipeline(track) {
    if (!track.streamUrl) {
      throw new Error(`Gagal mendapatkan direct stream audio untuk "${truncate(track.title, 50)}". Coba ulangi /play atau gunakan judul lagu.`);
    }

    const args = [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-probesize',
      '32M',
      '-analyzeduration',
      '15M',
      ...(track.seekSeconds > 0 ? ['-ss', String(track.seekSeconds)] : []),
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '5',
      '-i',
      track.streamUrl,
      '-reconnect_at_eof',
      '1',
      '-vn',
      '-sn',
      '-dn',
      '-map',
      'a?',
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
        new ButtonBuilder().setCustomId('player:autoplay').setLabel('Autoplay').setStyle(this.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('player:loop').setLabel(`Loop ${this.loopMode !== 'off' ? this.loopMode : ''}`).setStyle(this.loopMode !== 'off' ? ButtonStyle.Success : ButtonStyle.Secondary),
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
    this.consecutiveErrors = 0; // Reset counter jika skip manual
    this.skipRequested = true;
    this.playNonce += 1;
    this.player.stop(true);
  }

  async stop({ disconnect = false } = {}) {
    this.queue = [];
    this.current = null;
    this.autoplay = false;
    this.consecutiveErrors = 0;
    this.playNonce += 1;
    this.stopRequested = true;
    clearTimeout(this.sleepTimeout);
    this.sleepUntil = null;
    this.player.stop(true);

    if (this.currentProcess) {
      this.currentProcess.kill('SIGKILL');
      this.currentProcess = null;
    }

    this.clearLyricMessages();
    if (this.currentMessage) {
      await this.currentMessage.delete().catch(() => null);
      this.currentMessage = null;
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
    void this.publishNowPlaying('update');
  }

  nextLoopMode() {
    this.loopMode = this.loopMode === 'off' ? 'track' : this.loopMode === 'track' ? 'queue' : 'off';
    void this.publishNowPlaying('update');
    return this.loopMode;
  }

  toggleAutoplay() {
    this.autoplay = !this.autoplay;
    if (this.autoplay) {
      void this.prepareAutoplayTrack();
    } else {
      this.autoplayPreparePromise = null;
      this.autoplaySeedId = null;
    }
    void this.publishNowPlaying('update');
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
