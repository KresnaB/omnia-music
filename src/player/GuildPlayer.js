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
import { formatDuration, isTransientNetworkError, nowUnixPlus, truncate } from '../utils/format.js';

function isUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function isYoutubeAvailabilityError(error) {
  const message = String(error?.message || '').toLowerCase();
  return /youtube|yt-dlp|cookie|cookies|403|401|forbidden|sign in|login|premiere|player response|mweb|pot|extractor|stream failed|hydrate failed|metadata failed/.test(message);
}

function cloneTrack(track) {
  return structuredClone({
    ...track,
    preparedAt: null,
    seekSeconds: 0
  });
}

function getTrackIdentity(track) {
  if (!track) {
    return null;
  }

  return track.id || track.canonicalKey || track.webpageUrl || track.url || track.title || null;
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timeout setelah ${Math.ceil(timeoutMs / 1000)} detik`));
    }, timeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

const VOICE_RECONNECT_BASE_DELAY_MS = 5_000;
const VOICE_RECONNECT_MAX_DELAY_MS = 60_000;
const VOICE_RECONNECT_MAX_ATTEMPTS = 12;
const YOUTUBE_PROBE_COOLDOWN_MS = 2 * 60 * 1000;
const TRACK_PREPARE_TIMEOUT_MS = 45_000;
const PIPELINE_CREATE_TIMEOUT_MS = 20_000;
const PIPELINE_IDLE_WATCHDOG_MS = 4_000;

export class GuildPlayer {
  constructor({ client, guildId, ytdlp, lyrics, audioCache }) {
    this.client = client;
    this.guildId = guildId;
    this.ytdlp = ytdlp;
    this.lyrics = lyrics;
    this.audioCache = audioCache;
    this.queue = [];
    this.history = [];
    this.current = null;
    this.currentProcess = null;
    this.currentSourceProcess = null;
    this.currentMessage = null;
    this.playNonce = 0;
    this.loopMode = 'off';
    this.autoplay = false;
    this.shuffleActive = false;
    this.preloading = null;
    this.idleTimeout = null;
    this.emptyChannelTimeout = null;
    this.sleepTimeout = null;
    this.sleepUntil = null;
    this.lastTextChannelId = null;
    this.lyricMessages = [];
    this.consecutiveErrors = 0;
    this.skipRequested = false;
    this.skipTransitionActive = false;
    this.stopRequested = false;
    this.autoplayPreparePromise = null;
    this.autoplaySeedId = null;
    this.currentMetrics = null;
    this.preloadInFlight = new Set();
    this.playNextPromise = null;
    this.voiceChannelId = null;
    this.voiceReconnectPromise = null;
    this.voiceReconnectTimer = null;
    this.voiceReconnectAttempts = 0;
    this.voiceDisconnectNotified = false;
    this.pausedForVoiceReconnect = false;
    this.youtubeStatus = 'unknown';
    this.youtubeFailureReason = null;
    this.youtubeProbePromise = null;
    this.youtubeLastCheckedAt = 0;
    this.nowPlayingUpdatePromise = Promise.resolve();
    this.pipelineCompletionTimer = null;

    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });

    this.player.on(AudioPlayerStatus.Playing, async () => {
      this.skipTransitionActive = false;
      if (this.currentMetrics?.logged || !this.current) {
        return;
      }

      this.currentMetrics.logged = true;
      const now = Date.now();
      const metrics = this.currentMetrics;
      console.log(
        `[timing:${this.guildId}] "${truncate(this.current.title, 80)}" request_to_playing=${now - metrics.requestStartedAt}ms queue_wait=${metrics.playNextStartedAt - metrics.requestStartedAt}ms hydrate=${metrics.hydrateMs}ms pipeline=${metrics.pipelineMs}ms`
      );

      if (this.current.metadataPending) {
        try {
          await this.ytdlp.hydrateMetadata(this.current);
          await this.publishNowPlaying('metadata');
        } catch (error) {
          console.warn(`[player:${this.guildId}] metadata refresh failed:`, error.message);
        }
      }
    });

    this.player.on(AudioPlayerStatus.Idle, async () => {
      this.clearPipelineCompletionTimer();
      if (this.currentProcess) {
        this.currentProcess.kill('SIGKILL');
        this.currentProcess = null;
      }
      if (this.currentSourceProcess) {
        this.currentSourceProcess.kill('SIGKILL');
        this.currentSourceProcess = null;
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
        this.skipTransitionActive = false;
        this.resetIdleTimer();
        return;
      }
      await this.queuePlayNext('idle');
    });

    this.player.on('error', async (error) => {
      console.error(`[player:${this.guildId}]`, error);
      if (this.currentProcess) {
        this.currentProcess.kill('SIGKILL');
        this.currentProcess = null;
      }
      if (this.currentSourceProcess) {
        this.currentSourceProcess.kill('SIGKILL');
        this.currentSourceProcess = null;
      }
      
      this.consecutiveErrors++;
      const isNetwork = isTransientNetworkError(error);
      const errorMessage = isNetwork 
        ? '⚠️ Gangguan jaringan terdeteksi. Mencoba lagi...' 
        : `Playback error: ${error.message}. Mencoba lagu berikutnya...`;

      if (this.consecutiveErrors < 3) {
        await this.sendStatusMessage(errorMessage);
        void this.queuePlayNext(isNetwork ? 'network-retry' : 'error');
      } else {
        this.skipTransitionActive = false;
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
      sleepUntil: this.sleepUntil,
      youtubeStatus: this.youtubeStatus,
      youtubeFailureReason: this.youtubeFailureReason
    };
  }

  setYoutubeHealthy() {
    this.youtubeStatus = 'up';
    this.youtubeFailureReason = null;
  }

  setYoutubeUnavailable(reason) {
    this.youtubeStatus = 'down';
    this.youtubeFailureReason = reason || 'YouTube sedang bermasalah';
  }

  waitForPlaybackStart(timeoutMs = 5_000) {
    if (this.player.state.status === AudioPlayerStatus.Playing || this.player.state.status === AudioPlayerStatus.Paused) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('playback start timeout'));
      }, timeoutMs);

      const onPlaying = () => {
        cleanup();
        resolve();
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.player.off(AudioPlayerStatus.Playing, onPlaying);
      };

      this.player.on(AudioPlayerStatus.Playing, onPlaying);
    });
  }

  scheduleYoutubeAvailabilityProbe({ waitForPlaybackStart = false } = {}) {
    if (this.youtubeProbePromise) {
      return this.youtubeProbePromise;
    }

    if (Date.now() - this.youtubeLastCheckedAt < YOUTUBE_PROBE_COOLDOWN_MS) {
      return Promise.resolve();
    }

    this.youtubeProbePromise = (async () => {
      try {
        if (waitForPlaybackStart) {
          await this.waitForPlaybackStart().catch(() => null);
        }

        await this.ytdlp.resolve('ytsearch1:music');
        this.setYoutubeHealthy();
      } catch (error) {
        if (isYoutubeAvailabilityError(error)) {
          this.setYoutubeUnavailable(error.message);
        } else {
          console.warn(`[player:${this.guildId}] youtube probe failed:`, error.message);
        }
      } finally {
        this.youtubeLastCheckedAt = Date.now();
        this.youtubeProbePromise = null;
        if (this.current) {
          void this.publishNowPlaying('youtube-probe');
        }
      }
    })();

    return this.youtubeProbePromise;
  }

  getYoutubeStatusLabel() {
    if (this.youtubeStatus === 'down') {
      return `Error, failover ke cache${this.youtubeFailureReason ? `: ${truncate(this.youtubeFailureReason, 120)}` : ''}`;
    }

    if (this.youtubeStatus === 'up') {
      return 'Normal';
    }

    return 'Belum diperiksa';
  }

  clearPipelineCompletionTimer() {
    clearTimeout(this.pipelineCompletionTimer);
    this.pipelineCompletionTimer = null;
  }

  schedulePipelineCompletionAdvance(track, nonce, reason = 'pipeline-close') {
    const trackKey = getTrackIdentity(track);
    if (!trackKey || this.stopRequested) {
      return;
    }

    this.clearPipelineCompletionTimer();
    this.pipelineCompletionTimer = setTimeout(() => {
      this.pipelineCompletionTimer = null;

      if (this.stopRequested || this.skipRequested || this.playNonce !== nonce) {
        return;
      }

      const currentKey = getTrackIdentity(this.current);
      if (!currentKey || currentKey !== trackKey) {
        return;
      }

      if (this.player.state.status === AudioPlayerStatus.Idle) {
        return;
      }

      console.warn(
        `[player:${this.guildId}] forcing idle transition after ${reason} for "${truncate(track.title, 80)}"`
      );
      this.player.stop(true);
    }, PIPELINE_IDLE_WATCHDOG_MS);
  }

  maybeResumePlayback(reason = 'queue-update') {
    if (this.stopRequested || this.current || this.queue.length === 0 || this.playNextPromise) {
      return;
    }

    if (this.player.state.status === AudioPlayerStatus.Idle) {
      void this.queuePlayNext(reason);
    }
  }

  async buildCacheFallbackTrack({ requester, originalQuery = 'Cache Fallback', preferredQuery = '' } = {}) {
    const excludeCanonicalKeys = new Set([
      this.current?.canonicalKey,
      ...this.queue.map((track) => track.canonicalKey),
      ...this.history.map((track) => track.canonicalKey)
    ]);

    const bestMatch = await this.audioCache.getBestMatchTrack({
      query: preferredQuery || originalQuery,
      excludeCanonicalKeys: [...excludeCanonicalKeys].filter(Boolean),
      requester,
      originalQuery
    });

    if (bestMatch) {
      return bestMatch;
    }

    return this.audioCache.getAutoplayCandidate({
      excludeCanonicalKeys: [...excludeCanonicalKeys].filter(Boolean),
      requester,
      originalQuery
    });
  }

  async enqueue({ member, textChannel, query }) {
    this.lastTextChannelId = textChannel.id;
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      throw new Error('Kamu harus berada di voice channel terlebih dahulu');
    }

    const requester = { id: member.id, name: member.displayName };
    const requestStartedAt = Date.now();

    if (!isUrl(query)) {
      const localTrack = await this.audioCache.resolveQueryToTrack(query, {
        requester,
        addedAt: requestStartedAt,
        originalQuery: query,
        requestStartedAt
      });

      if (localTrack) {
        const isFirstPlay = !this.current;
        await this.ensureVoice(voiceChannel);
        this.insertUserTracks([localTrack]);
        void this.publishNowPlaying('queue-update');

        if (!this.current) {
          void this.queuePlayNext('enqueue');
        } else {
          void this.preloadUpcomingTracks();
        }

        if (isFirstPlay) {
          void this.scheduleYoutubeAvailabilityProbe({ waitForPlaybackStart: true });
        }

        return {
          type: 'single',
          fromCache: true,
          tracks: [localTrack]
        };
      }

      if (this.youtubeStatus === 'down') {
        const fallbackTrack = await this.buildCacheFallbackTrack({
          requester,
          originalQuery: `Cache failover untuk: ${query}`,
          preferredQuery: query
        });

        if (fallbackTrack) {
          await this.ensureVoice(voiceChannel);
          this.insertUserTracks([fallbackTrack]);
          void this.publishNowPlaying('queue-update');

          if (!this.current) {
            void this.queuePlayNext('enqueue-failover');
          } else {
            void this.preloadUpcomingTracks();
          }

          return {
            type: 'single',
            fromCache: true,
            failover: true,
            tracks: [fallbackTrack]
          };
        }
      }
    }

    this.youtubeStatus = 'unknown';
    this.youtubeFailureReason = null;

    // Jalankan join voice + resolve metadata secara paralel (hemat 2-4 detik)
    let resolved;
    try {
      [, resolved] = await Promise.all([
        this.ensureVoice(voiceChannel),
        this.ytdlp.resolve(query)
      ]);
      this.setYoutubeHealthy();
    } catch (error) {
      if (!isYoutubeAvailabilityError(error)) {
        throw error;
      }

      this.setYoutubeUnavailable(error.message);
      const fallbackTrack = await this.buildCacheFallbackTrack({
        requester,
        originalQuery: `Cache failover untuk: ${query}`,
        preferredQuery: query
      });

      if (!fallbackTrack) {
        throw new Error(`YouTube sedang error dan cache lokal kosong: ${truncate(error.message || 'unknown error', 250)}`);
      }

      this.insertUserTracks([fallbackTrack]);
      void this.publishNowPlaying('queue-update');

      if (!this.current) {
        void this.queuePlayNext('enqueue-failover');
      } else {
        void this.preloadUpcomingTracks();
      }

      return {
        type: 'single',
        fromCache: true,
        failover: true,
        tracks: [fallbackTrack]
      };
    }

    const tracks = resolved.tracks.map((track) => ({
      ...track,
      requester,
      addedAt: Date.now(),
      originalQuery: query,
      requestStartedAt: Date.now()
    }));

    if (resolved.type === 'playlist' && tracks[0]) {
      try {
        await this.ytdlp.hydrate(tracks[0]);
      } catch (error) {
        console.warn(`[player:${this.guildId}] first playlist track pre-hydrate failed:`, error.message);
      }
    }

    this.insertUserTracks(tracks);
    void this.publishNowPlaying('queue-update');

    if (!this.current) {
      void this.queuePlayNext('enqueue');
    } else {
      void this.preloadUpcomingTracks();
    }

    return { ...resolved, tracks };
  }

  insertUserTracks(tracks) {
    this.shuffleActive = false;
    
    // Hapus lagu autoplay lama yang sudah mengantre
    this.queue = this.queue.filter((track) => track.requester?.id !== 'autoplay');
    
    // Batalkan/reset referensi background promise autoplay lama jika ada
    this.autoplaySeedId = null;

    this.queue.push(...tracks);
  }

  async ensureVoice(voiceChannel) {
    this.voiceChannelId = voiceChannel.id;
    clearTimeout(this.voiceReconnectTimer);
    this.voiceReconnectTimer = null;
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

    this.attachConnectionHandlers(connection);

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
    this.voiceReconnectAttempts = 0;
    this.voiceDisconnectNotified = false;
    this.refreshEmptyChannelTimeout();
    return connection;
  }

  attachConnectionHandlers(connection) {
    if (connection.__omniaHandlersAttached) {
      return;
    }

    connection.__omniaHandlersAttached = true;
    connection.on(VoiceConnectionStatus.Ready, () => {
      this.voiceReconnectAttempts = 0;
      this.voiceDisconnectNotified = false;
      if (this.current && this.pausedForVoiceReconnect) {
        this.player.unpause();
      }
      this.pausedForVoiceReconnect = false;
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void this.handleVoiceDisconnected(connection);
    });
  }

  async handleVoiceDisconnected(connection) {
    if (this.stopRequested) {
      return;
    }

    if (!this.pausedForVoiceReconnect && this.player.state.status === AudioPlayerStatus.Playing) {
      this.pausedForVoiceReconnect = this.player.pause();
    }

    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
      ]);
      return;
    } catch {
      this.scheduleVoiceReconnect();
    }
  }

  scheduleVoiceReconnect() {
    if (this.voiceReconnectPromise || this.voiceReconnectTimer || this.stopRequested || !this.voiceChannelId) {
      return;
    }

    const attempt = this.voiceReconnectAttempts + 1;
    const delayMs = Math.min(
      VOICE_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
      VOICE_RECONNECT_MAX_DELAY_MS
    );

    this.voiceReconnectTimer = setTimeout(() => {
      this.voiceReconnectTimer = null;
      this.voiceReconnectPromise = this.recoverVoiceConnection(attempt).finally(() => {
        this.voiceReconnectPromise = null;
      });
      void this.voiceReconnectPromise;
    }, delayMs);

    if (!this.voiceDisconnectNotified) {
      this.voiceDisconnectNotified = true;
      void this.sendStatusMessage('Koneksi voice terputus. Bot akan mencoba reconnect otomatis.');
    }
  }

  async recoverVoiceConnection(attempt = this.voiceReconnectAttempts + 1) {
    if (!this.voiceChannelId) {
      return;
    }

    const channel = await this.client.channels.fetch(this.voiceChannelId).catch(() => null);
    if (!channel?.isVoiceBased?.()) {
      this.voiceReconnectAttempts = 0;
      this.pausedForVoiceReconnect = false;
      await this.sendStatusMessage('Voice channel tidak ditemukan untuk reconnect otomatis.');
      return;
    }

    try {
      this.voiceReconnectAttempts = attempt;
      const connection = getVoiceConnection(this.guildId);
      connection?.destroy();
      await this.ensureVoice(channel);
      if (this.current && this.pausedForVoiceReconnect) {
        this.player.unpause();
      }
      this.pausedForVoiceReconnect = false;
      await this.sendStatusMessage('Koneksi voice terputus. Berhasil reconnect otomatis.');
    } catch (error) {
      const shouldRetry = attempt < VOICE_RECONNECT_MAX_ATTEMPTS && !this.stopRequested;
      if (shouldRetry) {
        await this.sendStatusMessage(
          `Reconnect voice otomatis gagal (${attempt}/${VOICE_RECONNECT_MAX_ATTEMPTS}): ${truncate(error.message || 'unknown error', 160)}. Akan coba lagi.`
        );
        this.scheduleVoiceReconnect();
        return;
      }

      this.pausedForVoiceReconnect = false;
      await this.sendStatusMessage(
        `Reconnect voice otomatis gagal setelah ${attempt} percobaan: ${truncate(error.message || 'unknown error', 300)}. Gunakan /reconnect atau /play lagi.`
      );
    }
  }

  resetIdleTimer() {
    clearTimeout(this.idleTimeout);
    this.idleTimeout = setTimeout(() => {
      void this.sendStatusMessage('Tidak ada lagu yang diputar selama 3 menit. Bot disconnect otomatis.');
      void this.stop({ disconnect: true });
    }, config.defaultIdleTimeoutMs);
  }

  clearEmptyChannelTimeout() {
    clearTimeout(this.emptyChannelTimeout);
    this.emptyChannelTimeout = null;
  }

  scheduleEmptyChannelTimeout() {
    if (this.emptyChannelTimeout || !this.voiceChannelId || this.stopRequested) {
      return;
    }

    this.emptyChannelTimeout = setTimeout(() => {
      this.emptyChannelTimeout = null;
      void this.sendStatusMessage('Tidak ada listener di voice channel selama 3 menit. Playback dihentikan dan bot disconnect.');
      void this.stop({ disconnect: true });
    }, config.emptyChannelTimeoutMs);
  }

  async refreshEmptyChannelTimeout() {
    if (!this.voiceChannelId) {
      this.clearEmptyChannelTimeout();
      return;
    }

    const channel = await this.client.channels.fetch(this.voiceChannelId).catch(() => null);
    if (!channel?.isVoiceBased?.()) {
      this.clearEmptyChannelTimeout();
      return;
    }

    const hasHumanListener = channel.members?.some((member) => !member.user?.bot);
    if (hasHumanListener) {
      this.clearEmptyChannelTimeout();
      return;
    }

    this.scheduleEmptyChannelTimeout();
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
    if (this.queue.length <= 1) {
      this.shuffleActive = false;
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

  async closePlayerMessage() {
    this.clearLyricMessages();
    if (this.currentMessage) {
      await this.currentMessage.delete().catch(() => null);
      this.currentMessage = null;
    }
  }

  buildDisabledControlRows() {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('player:toggle').setLabel('Pause').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('player:skip').setLabel('Skip').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('player:stop').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(true),
        new ButtonBuilder().setCustomId('player:shuffle').setLabel('Shuffle').setStyle(ButtonStyle.Secondary).setDisabled(true)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('player:autoplay').setLabel('Autoplay').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('player:loop').setLabel('Loop').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('player:queue').setLabel('Queue').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('player:lyrics').setLabel('Lyrics').setStyle(ButtonStyle.Secondary).setDisabled(true)
      )
    ];
  }

  async publishIdleMessage() {
    const runUpdate = async () => {
      if (!this.lastTextChannelId) return;
      const channel = await this.client.channels.fetch(this.lastTextChannelId).catch(() => null);
      if (!channel?.isTextBased()) return;

      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setAuthor({ name: 'Player Idle' })
        .setTitle('Tidak ada lagu yang sedang diputar')
        .setDescription([
          'Queue habis dan tidak ada lagu berikutnya yang bisa diputar.',
          '',
          `Bot akan disconnect otomatis dalam <t:${nowUnixPlus(Math.floor(config.emptyChannelTimeoutMs / 1000))}:R> jika belum ada lagu lagi.`
        ].join('\n'));
      const components = this.buildDisabledControlRows();

      if (this.currentMessage) {
        try {
          this.currentMessage = await this.currentMessage.edit({ embeds: [embed], components });
          return;
        } catch {
          this.currentMessage = null;
        }
      }

      this.currentMessage = await channel.send({ embeds: [embed], components });
    };

    this.nowPlayingUpdatePromise = this.nowPlayingUpdatePromise
      .then(runUpdate, runUpdate)
      .catch(() => null);

    await this.nowPlayingUpdatePromise;
  }

  async preloadUpcomingTracks() {
    const nextTrack = this.queue[0];
    if (!nextTrack?.id || this.preloadInFlight.has(nextTrack.id)) {
      return;
    }

    this.preloadInFlight.add(nextTrack.id);
    try {
      await this.prepareTrackForPlayback(nextTrack, { trigger: 'preload', allowBackgroundDownload: true });
    } catch (error) {
      console.warn(`[player:${this.guildId}] preload failed for ${nextTrack.title}:`, error.message);
    } finally {
      this.preloadInFlight.delete(nextTrack.id);
    }
  }

  getTrackCacheStatusLabel(track) {
    if (!track) {
      return 'Tidak diketahui';
    }

    if (track.localPath) {
      return 'Diputar dari cache lokal';
    }

    switch (track.cacheStatus) {
      case 'downloading':
        return 'Streaming + download cache berjalan';
      case 'cached':
        return 'Tersimpan di cache';
      case 'failed':
        return `Download cache gagal${track.cacheError ? `: ${truncate(track.cacheError, 80)}` : ''}`;
      case 'queued':
        return 'Menunggu download cache';
      case 'skipped':
        return track.cacheError ? `Cache dilewati: ${truncate(track.cacheError, 80)}` : 'Cache tidak dijalankan';
      default:
        return 'Streaming langsung';
    }
  }

  async syncCurrentMessageIfTrack(track) {
    if (!this.current || !track) {
      return;
    }

    const currentKey = this.current.canonicalKey || this.current.id || this.current.webpageUrl || this.current.title;
    const trackKey = track.canonicalKey || track.id || track.webpageUrl || track.title;
    if (currentKey !== trackKey) {
      return;
    }

    await this.publishNowPlaying('cache-update');
  }

  queueCacheDownload(track) {
    if (!track || track.localPath) {
      return;
    }

    if (track.duration > config.audioCacheMaxDurationSeconds) {
      track.cacheStatus = 'skipped';
      track.cacheError = `durasi > ${Math.floor(config.audioCacheMaxDurationSeconds / 60)} menit`;
      void this.syncCurrentMessageIfTrack(track);
      return;
    }

    track.cacheStatus = 'downloading';
    track.cacheError = null;
    void this.syncCurrentMessageIfTrack(track);

    void this.audioCache
      .queueDownload(track)
      .then(async (entry) => {
        if (!entry) {
          track.cacheStatus = 'failed';
          track.cacheError ??= 'download tidak berhasil';
          await this.syncCurrentMessageIfTrack(track);
          return;
        }

        track.cacheStatus = 'cached';
        track.cacheError = null;
        await this.syncCurrentMessageIfTrack(track);
      })
      .catch(async (error) => {
        track.cacheStatus = 'failed';
        track.cacheError = error.message;
        await this.syncCurrentMessageIfTrack(track);
      });
  }

  async prepareTrackForPlayback(track, { trigger = 'play', allowBackgroundDownload = true } = {}) {
    if (track.localPath) {
      track.cacheStatus = 'cached';
      track.cacheError = null;
      return track;
    }

    await this.audioCache.hydrateLocalReference(track);

    if (track.localPath) {
      track.cacheStatus = 'cached';
      track.cacheError = null;
      return track;
    }

    if (this.youtubeStatus === 'down') {
      throw new Error('YouTube sedang error, playback dibatasi ke lagu cache lokal.');
    }

    if (track.metadataPending) {
      await this.ytdlp.hydrateMetadata(track);
    }

    await this.ytdlp.ensureStreamUrl(track);

    if (allowBackgroundDownload) {
      this.queueCacheDownload(track);
    } else {
      track.cacheStatus = 'skipped';
    }

    return track;
  }

  async prepareAutoplayTrack() {
    const seed = this.current || this.history[this.history.length - 1];
    const seedKey = getTrackIdentity(seed);
    if (!this.autoplay || !seed) {
      return;
    }

    if (this.queue.length > 0) {
      await this.preloadUpcomingTracks();
      return;
    }

    const hasAutoplayQueued = this.queue.some((track) => track.requester?.id === 'autoplay');
    if (hasAutoplayQueued) {
      return;
    }

    if (this.autoplayPreparePromise && this.autoplaySeedId === seedKey) {
      await this.autoplayPreparePromise;
      return;
    }

    this.autoplaySeedId = seedKey;
    this.autoplayPreparePromise = (async () => {
      try {
        if (this.youtubeStatus === 'down') {
          const cached = await this.buildCacheFallbackTrack({
            requester: { id: 'autoplay', name: 'Autoplay Cache' },
            originalQuery: 'Cache Autoplay',
            preferredQuery: `${seed.title || ''} ${seed.uploader || ''}`.trim()
          });

          if (cached && this.autoplaySeedId === seedKey) {
            this.queue.push(cached);
            this.shuffleActive = false;
            void this.publishNowPlaying('queue-update');
            this.maybeResumePlayback('autoplay-cache-ready');
          }
          return;
        }

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

        // Abaikan push jika referensi seed sudah di-reset oleh enqueue manual user
        if (this.autoplaySeedId !== seedKey) {
          return;
        }

        const isDuplicate = (track) => {
          if (track.id && prepared.id && track.id === prepared.id) return true;
          if (track.canonicalKey && prepared.canonicalKey && track.canonicalKey === prepared.canonicalKey) return true;
          return false;
        };

        const existsInQueue = this.queue.some(isDuplicate);
        const existsInHistory = this.history.some(isDuplicate);
        const isCurrent = this.current && isDuplicate(this.current);

        if (!existsInQueue && !existsInHistory && !isCurrent) {
          this.queue.push(prepared);
          this.shuffleActive = false;
          void this.publishNowPlaying('queue-update');
          this.maybeResumePlayback('autoplay-ready');
        }
      } catch (error) {
        console.warn(`[player:${this.guildId}] autoplay prepare failed:`, error.message);
      } finally {
        if (this.autoplaySeedId === seedKey || this.autoplaySeedId === null) {
          this.autoplayPreparePromise = null;
        }
      }
    })();

    await this.autoplayPreparePromise;
  }

  async queuePlayNext(reason = 'manual') {
    const previous = this.playNextPromise || Promise.resolve();
    const nextRun = previous.then(() => this.playNext(reason), () => this.playNext(reason));
    this.playNextPromise = nextRun.finally(() => {
      if (this.playNextPromise === nextRun) {
        this.playNextPromise = null;
      }
    });
    return this.playNextPromise;
  }

  async playNext(reason = 'manual') {
    clearTimeout(this.idleTimeout);
    this.clearPipelineCompletionTimer();

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
      this.skipTransitionActive = false;
      await this.publishIdleMessage();
      this.resetIdleTimer();
      return;
    }

    this.playNonce += 1;
    const nonce = this.playNonce;
    const metrics = {
      requestStartedAt: next.requestStartedAt || next.addedAt || Date.now(),
      playNextStartedAt: Date.now(),
      hydrateMs: 0,
      pipelineMs: 0,
      logged: false
    };

    try {
      const hydrateStartedAt = Date.now();
      await withTimeout(
        this.prepareTrackForPlayback(next, { trigger: reason, allowBackgroundDownload: true }),
        TRACK_PREPARE_TIMEOUT_MS,
        'persiapan track'
      );
      metrics.hydrateMs = Date.now() - hydrateStartedAt;

      const pipelineStartedAt = Date.now();
      const prepared = await withTimeout(
        this.createAudioPipeline(next),
        PIPELINE_CREATE_TIMEOUT_MS,
        'pembuatan audio pipeline'
      );
      metrics.pipelineMs = Date.now() - pipelineStartedAt;

      if (nonce !== this.playNonce) {
        prepared.process.kill('SIGKILL');
        prepared.sourceProcess?.kill('SIGKILL');
        return;
      }

      if (this.currentProcess) {
        this.currentProcess.kill('SIGKILL');
      }
      if (this.currentSourceProcess) {
        this.currentSourceProcess.kill('SIGKILL');
      }

      this.clearLyricMessages();
      this.currentProcess = prepared.process;
      this.currentSourceProcess = prepared.sourceProcess || null;
      this.currentMetrics = metrics;
      prepared.process.once('close', () => {
        this.schedulePipelineCompletionAdvance(next, nonce, 'ffmpeg-close');
      });
      this.player.play(prepared.resource);
      await this.publishNowPlaying(reason);
      void this.preloadUpcomingTracks();
      if (this.autoplay && this.queue.length === 0) {
        void this.prepareAutoplayTrack();
      }
    } catch (error) {
      console.error(`[player:${this.guildId}] playNext failed:`, error.message);
      if (isYoutubeAvailabilityError(error) || isTransientNetworkError(error)) {
        const isNetwork = isTransientNetworkError(error);
        if (isNetwork) {
          await this.sendStatusMessage('⚠️ Gangguan jaringan terdeteksi saat menyiapkan lagu. Mencoba beralih ke cache...');
        }
        
        this.setYoutubeUnavailable(error.message);
        const fallbackTrack = await this.buildCacheFallbackTrack({
          requester: next.requester || { id: 'autoplay', name: 'Cache Failover' },
          originalQuery: `Cache failover untuk: ${next.title}`,
          preferredQuery: `${next.title || ''} ${next.uploader || ''} ${next.originalQuery || ''}`.trim()
        });

        if (fallbackTrack) {
          if (!isNetwork) {
            await this.sendStatusMessage('YouTube sedang error. Bot beralih memutar lagu dari cache lokal yang tersedia.');
          }
          this.current = null;
          this.queue.unshift(fallbackTrack);
          void this.queuePlayNext('youtube-failover');
          return;
        }
      }
      this.consecutiveErrors++;

      if (this.consecutiveErrors < 3) {
        const isNetwork = isTransientNetworkError(error);
        await this.sendStatusMessage(
          isNetwork 
            ? '⚠️ Gagal memutar karena gangguan jaringan. Mencoba lagu berikutnya...'
            : `Gagal memutar "${next.title}": ${error.message}. Melewati...`
        );
        // Tunggu sebentar sebelum skip otomatis untuk menghindari spam API gila-gilaan
        await new Promise(r => setTimeout(r, 2000));
        void this.queuePlayNext('fallback');
        return;
      } else {
        await this.sendStatusMessage(`❌ Terjadi kesalahan berulang (${this.consecutiveErrors}x). Menghentikan playback.`);
        await this.stop();
      }
    }
  }

  buildHttpHeaders(track) {
    const headers = { ...(track.httpHeaders || {}) };

    if (track.webpageUrl && /^https?:\/\//.test(track.webpageUrl)) {
      headers.Referer ??= track.webpageUrl;
    }

    headers.Origin ??= 'https://www.youtube.com';
    headers['User-Agent'] ??= 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

    return Object.entries(headers)
      .filter(([, value]) => value !== null && value !== undefined && String(value).length > 0)
      .map(([key, value]) => `${key}: ${value}\r\n`)
      .join('');
  }

  buildFfmpegArgs(track, profile = 'opus') {
    return this.buildFfmpegArgsForInput(track, profile, 'url');
  }

  buildFfmpegArgsForInput(track, profile = 'opus', inputMode = 'url') {
    const headers = inputMode === 'url' ? this.buildHttpHeaders(track) : '';
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error'];

    if (inputMode === 'local') {
      args.push(
        '-fflags',
        '+genpts',
        '-probesize',
        '4M',
        '-analyzeduration',
        '2M'
      );
    } else {
      args.push(
        '-fflags',
        '+discardcorrupt+genpts',
        '-probesize',
        '32M',
        '-analyzeduration',
        '15M'
      );
    }

    if (inputMode === 'url' || inputMode === 'local') {
      args.push(
        ...(track.seekSeconds > 0 ? ['-ss', String(track.seekSeconds)] : [])
      );

      if (inputMode === 'url') {
        args.push(
          '-reconnect',
          '1',
          '-reconnect_streamed',
          '1',
          '-reconnect_on_network_error',
          '1',
          '-reconnect_on_http_error',
          '4xx,5xx',
          '-reconnect_delay_max',
          '5'
        );
      }

      if (headers) {
        args.push('-headers', headers);
      }
    }

    args.push(
      '-i',
      inputMode === 'stdin' ? 'pipe:0' : inputMode === 'local' ? track.localPath : track.streamUrl,
      '-vn',
      '-sn',
      '-dn',
      '-map',
      'a?',
      '-af',
      'aresample=async=1:min_hard_comp=0.100:first_pts=0'
    );

    if (profile === 'pcm') {
      args.push(
        '-f',
        's16le',
        '-ar',
        '48000',
        '-ac',
        '2',
        'pipe:1'
      );
      return args;
    }

    args.push(
      '-c:a',
      'libopus',
      '-application',
      'audio',
      '-frame_duration',
      '20',
      '-compression_level',
      '10',
      '-b:a',
      '128k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-f',
      'ogg',
      'pipe:1'
    );
    return args;
  }

  buildYtDlpPipeArgs(track) {
    const target = track.webpageUrl || track.url || track.searchQuery || track.title;
    const args = [
      '--default-search',
      config.defaultSearchPlatform,
      '--no-warnings',
      '--no-progress',
      '--skip-download',
      '--no-playlist',
      '-f',
      'bestaudio/best',
      '-o',
      '-',
      target
    ];

    if (config.ytDlpYoutubeArgs) {
      args.push('--extractor-args', config.ytDlpYoutubeArgs);
    }

    if (config.ytDlpPotProviderArgs) {
      args.push('--extractor-args', config.ytDlpPotProviderArgs);
    }

    if (config.ytDlpCookiesFile) {
      args.push('--cookies', config.ytDlpCookiesFile);
    }

    return args;
  }

  spawnAudioProcess(track, profile = 'opus', inputMode = 'url', sourceProcess = null) {
    const args = this.buildFfmpegArgsForInput(track, profile, inputMode);
    const process = spawn(config.ffmpegPath, args, {
      stdio: [inputMode === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    let probeReady = false;
    process.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    if (sourceProcess?.stdout && inputMode === 'stdin') {
      sourceProcess.stdout.pipe(process.stdin);
      sourceProcess.stdout.on('error', () => null);
      process.stdin.on('error', () => null);
    }

    const startupFailure = new Promise((_, reject) => {
      process.once('error', (error) => {
        reject(new Error(`ffmpeg spawn failed: ${error.message}`));
      });
      process.once('close', (code) => {
        if (probeReady) {
          return;
        }
        reject(
          new Error(
            code && stderr.trim()
              ? `ffmpeg exited with code ${code}: ${truncate(stderr.trim(), 500)}`
              : 'ffmpeg berhenti sebelum stream audio siap'
          )
        );
      });
    });

    const probe = Promise.race([
      demuxProbe(process.stdout),
      startupFailure
    ]);

    return {
      process,
      sourceProcess,
      probe,
      markProbeReady: () => {
        probeReady = true;
      },
      stderr: () => stderr
    };
  }

  async createAudioPipeline(track) {
    if (!track.localPath && !track.streamUrl) {
      throw new Error(`Gagal mendapatkan direct stream audio untuk "${truncate(track.title, 50)}". Coba ulangi /play atau gunakan judul lagu.`);
    }

    const primaryInputMode = track.localPath ? 'local' : 'url';
    let processState = this.spawnAudioProcess(track, 'opus', primaryInputMode);
    let probed;

    try {
      probed = await processState.probe;
    } catch (error) {
      processState.process.kill('SIGKILL');
      processState.sourceProcess?.kill('SIGKILL');
      const message = String(error?.message || '');
      const canRetryWithPcm =
        /libopus|encoder|codec|output format|s16le|ogg/i.test(message) ||
        /Unknown encoder|Invalid argument|could not write header/i.test(message);
      const canRetryViaYtDlpPipe =
        primaryInputMode === 'url' &&
        /403|401|404|server returned|input\/output error|end of file|invalid data found|Connection reset|Forbidden|googlevideo/i.test(message);

      if (canRetryViaYtDlpPipe) {
        const sourceProcess = spawn(config.ytDlpPath, this.buildYtDlpPipeArgs(track), {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        processState = this.spawnAudioProcess(track, 'opus', 'stdin', sourceProcess);
        try {
          probed = await processState.probe;
        } catch (pipeError) {
          processState.process.kill('SIGKILL');
          processState.sourceProcess?.kill('SIGKILL');
          const pipeMessage = String(pipeError?.message || '');
          const canRetryPipeWithPcm =
            /libopus|encoder|codec|output format|s16le|ogg/i.test(pipeMessage) ||
            /Unknown encoder|Invalid argument|could not write header/i.test(pipeMessage);

          if (!canRetryPipeWithPcm) {
            throw pipeError;
          }

          processState.sourceProcess?.kill('SIGKILL');
          const sourceProcessPcm = spawn(config.ytDlpPath, this.buildYtDlpPipeArgs(track), {
            stdio: ['ignore', 'pipe', 'pipe']
          });
          processState = this.spawnAudioProcess(track, 'pcm', 'stdin', sourceProcessPcm);
          try {
            probed = await processState.probe;
          } catch (pipeRetryError) {
            processState.process.kill('SIGKILL');
            processState.sourceProcess?.kill('SIGKILL');
            throw pipeRetryError;
          }
        }
      } else {
        if (!canRetryWithPcm) {
          throw error;
        }

        processState = this.spawnAudioProcess(track, 'pcm', primaryInputMode);
        try {
          probed = await processState.probe;
        } catch (retryError) {
          processState.process.kill('SIGKILL');
          processState.sourceProcess?.kill('SIGKILL');
          throw retryError;
        }
      }
    }
    processState.markProbeReady();
    const resource = createAudioResource(probed.stream, {
      inputType: probed.type,
      metadata: track
    });

    const finalStderr = processState.stderr().trim();
    processState.process.once('close', (code) => {
      if (this.currentProcess === processState.process) {
        this.currentProcess = null;
      }
      if (this.currentSourceProcess === processState.sourceProcess) {
        this.currentSourceProcess = null;
      }
      if (code && code !== 0 && finalStderr) {
        console.warn(`[player:${this.guildId}] ffmpeg exited with code ${code}: ${truncate(finalStderr, 500)}`);
      }
    });

    return { resource, process: processState.process, sourceProcess: processState.sourceProcess };
  }

  async publishNowPlaying() {
    const runUpdate = async () => {
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
    };

    this.nowPlayingUpdatePromise = this.nowPlayingUpdatePromise
      .then(runUpdate, runUpdate)
      .catch(() => null);

    await this.nowPlayingUpdatePromise;
  }

  buildNowPlayingEmbed() {
    const status = this.status();
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: 'Now Playing' })
      .setTitle(truncate(this.current.title, 256) || 'Unknown')
      .setDescription([
        `👤 **Uploader:** ${truncate(this.current.uploader || 'Unknown', 50)}`,
        `⏱️ **Duration:** \`${formatDuration(this.current.duration)}\``,
        `💾 **Source:** \`${this.current.localPath ? 'local-cache' : 'stream'}\``,
        `📦 **Cache:** ${this.getTrackCacheStatusLabel(this.current)}`,
        '',
        `YouTube: ${this.getYoutubeStatusLabel()}`,
        `**Settings:** Loop \`${status.loopMode}\` | Autoplay \`${status.autoplay ? 'On' : 'Off'}\` | Queue \`${this.queue.length}\``
      ].join('\n'))
      .setFooter({ text: `Requested by ${this.current.requester?.name || 'Unknown'}` });

    if (this.current.webpageUrl) embed.setURL(this.current.webpageUrl);
    if (this.current.thumbnail) embed.setThumbnail(this.current.thumbnail);

    return embed;
  }

  buildControlRows() {
    const isPaused = this.player.state.status === AudioPlayerStatus.Paused;

    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('player:toggle').setLabel(isPaused ? '▶️ Resume' : '⏸️ Pause').setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('player:skip').setLabel('⏭️ Skip').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('player:stop').setLabel('⏹️ Stop').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('player:shuffle').setLabel('🔀 Shuffle').setStyle(this.shuffleActive ? ButtonStyle.Success : ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('player:autoplay').setLabel('✨ Autoplay').setStyle(this.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('player:loop').setLabel(`🔁 Loop ${this.loopMode !== 'off' ? this.loopMode : ''}`).setStyle(this.loopMode !== 'off' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('player:queue').setLabel('📋 Queue').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('player:lyrics').setLabel('🎤 Lyrics').setStyle(ButtonStyle.Secondary)
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

  async notifyNetworkRestored() {
    if (!this.lastTextChannelId || (!this.current && this.queue.length === 0)) {
      return;
    }

    await this.sendStatusMessage('⚠️ **Koneksi internet terganggu.** Barusan terjadi gangguan jaringan (*network outage*) yang menyebabkan playback/pencarian terganggu. Sekarang koneksi sudah kembali normal.');
    
    // Jika player idle tetapi ada antrean, coba lanjut
    if (this.player.state.status === AudioPlayerStatus.Idle && this.queue.length > 0 && !this.stopRequested) {
      void this.queuePlayNext('network-recovery');
    }
  }

  async skip() {
    if (!this.current && !this.playNextPromise) {
      throw new Error('Tidak ada lagu yang sedang diputar');
    }

    if (this.skipTransitionActive) {
      return false;
    }

    this.consecutiveErrors = 0; // Reset counter jika skip manual
    this.skipRequested = true;
    this.skipTransitionActive = true;
    this.playNonce += 1;

    if (this.player.state.status === AudioPlayerStatus.Idle) {
      if (this.current) {
        const finished = this.current;
        finished.seekSeconds = 0;
        this.history.push(finished);
        if (this.history.length > 25) {
          this.history = this.history.slice(-25);
        }
      }
      this.current = null;
      this.skipRequested = false;
      void this.queuePlayNext('skip');
    } else {
      this.player.stop(true);
    }

    return true;
  }

  async stop({ disconnect = false } = {}) {
    this.clearPipelineCompletionTimer();
    this.queue = [];
    this.current = null;
    this.currentMetrics = null;
    this.autoplay = false;
    this.shuffleActive = false;
    this.consecutiveErrors = 0;
    this.playNonce += 1;
    this.stopRequested = true;
    this.skipTransitionActive = false;
    clearTimeout(this.voiceReconnectTimer);
    this.voiceReconnectTimer = null;
    this.voiceReconnectAttempts = 0;
    this.voiceDisconnectNotified = false;
    this.pausedForVoiceReconnect = false;
    this.clearEmptyChannelTimeout();
    clearTimeout(this.sleepTimeout);
    this.sleepUntil = null;
    this.player.stop(true);

    if (this.currentProcess) {
      this.currentProcess.kill('SIGKILL');
      this.currentProcess = null;
    }
    if (this.currentSourceProcess) {
      this.currentSourceProcess.kill('SIGKILL');
      this.currentSourceProcess = null;
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
      void this.publishNowPlaying('update');
      return false;
    }
    this.player.pause();
    void this.publishNowPlaying('update');
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
    this.shuffleActive = this.queue.length > 1;
    void this.preloadUpcomingTracks();
    void this.publishNowPlaying('queue-update');
    return this.queue.length;
  }

  move(from, to) {
    this.shuffleActive = false;
    if (from < 1 || from > this.queue.length || to < 1 || to > this.queue.length) {
      throw new Error('Posisi queue tidak valid');
    }

    const [track] = this.queue.splice(from - 1, 1);
    this.queue.splice(to - 1, 0, track);
    void this.preloadUpcomingTracks();
    void this.publishNowPlaying('queue-update');
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
    if (this.autoplay && this.queue.length === 0) {
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
