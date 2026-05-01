import { spawn } from "node:child_process";
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
  joinVoiceChannel,
} from "@discordjs/voice";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { config } from "../config.js";
import {
  formatDuration,
  isTransientNetworkError,
  nowUnixPlus,
  truncate,
} from "../utils/format.js";

function isUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function isYoutubeAvailabilityError(error) {
  const message = String(error?.message || "").toLowerCase();
  return /youtube|yt-dlp|cookie|cookies|403|401|forbidden|sign in|login|premiere|player response|mweb|pot|extractor|stream failed|hydrate failed|metadata failed/.test(
    message,
  );
}

function needsAutoplaySeedHydration(track) {
  if (!track) {
    return false;
  }

  return Boolean(
    track.metadataPending ||
    !track.id ||
    !track.uploader ||
    track.uploader === "Loading..." ||
    isUrl(track.title) ||
    (isUrl(track.url) && String(track.id || "").length !== 11),
  );
}

function cloneTrack(track) {
  return structuredClone({
    ...track,
    preparedAt: null,
    seekSeconds: 0,
  });
}

function getTrackIdentity(track) {
  if (!track) {
    return null;
  }

  return (
    track.id ||
    track.canonicalKey ||
    track.webpageUrl ||
    track.url ||
    track.title ||
    null
  );
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `${label} timeout setelah ${Math.ceil(timeoutMs / 1000)} detik`,
        ),
      );
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
const CROSSFADE_DURATION_SECONDS = 3;
const CROSSFADE_FADE_IN_DURATION_SECONDS = 2;

export class GuildPlayer {
  constructor({ client, guildId, ytdlp, lyrics, audioCache }) {
    console.log(`[GUILDPLAYER:${guildId}] Creating GuildPlayer instance`);
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
    this.loopMode = "off";
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
    this.youtubeStatus = "unknown";
    this.youtubeFailureReason = null;
    this.youtubeProbePromise = null;
    this.youtubeLastCheckedAt = 0;
    this.nowPlayingUpdatePromise = Promise.resolve();
    this.pipelineCompletionTimer = null;
    this.playbackStartedAt = null;
    this.finishedTrack = null;
    this.crossfadeBufferTimer = null;

    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });

    this.player.on(AudioPlayerStatus.Playing, async () => {
      this.skipTransitionActive = false;
      this.stopRequested = false;
      this.playbackStartedAt = Date.now();
      console.log(`[PLAYING:${this.guildId}] Playing event fired | current=${
        this.current ? truncate(this.current.title, 80) : 'null'
      } | metricsLogged=${
        this.currentMetrics?.logged
      } | queue=${this.queue.length} | autoplay=${this.autoplay} | stopReqReset`);
      if (this.currentMetrics?.logged || !this.current) {
        return;
      }

      this.currentMetrics.logged = true;
      const now = Date.now();
      const metrics = this.currentMetrics;
      console.log(
        `[timing:${this.guildId}] "${truncate(this.current.title, 80)}" request_to_playing=${now - metrics.requestStartedAt}ms queue_wait=${metrics.playNextStartedAt - metrics.requestStartedAt}ms hydrate=${metrics.hydrateMs}ms pipeline=${metrics.pipelineMs}ms`,
      );

      if (this.current.metadataPending) {
        try {
          await this.ytdlp.hydrateMetadata(this.current);
          await this.publishNowPlaying("metadata");
        } catch (error) {
          console.warn(
            `[player:${this.guildId}] metadata refresh failed:`,
            error.message,
          );
        }
      }
    });

    this.player.on(AudioPlayerStatus.Idle, async () => {
      this.clearPipelineCompletionTimer();

      console.log(`[IDLE:${this.guildId}] Idle event fired | skipTransitionActive=${this.skipTransitionActive} | skipRequested=${this.skipRequested} | stopRequested=${this.stopRequested} | current=${this.current ? truncate(this.current.title, 80) : 'null'} | queue=${this.queue.length} | autoplay=${this.autoplay} | loopMode=${this.loopMode}`);

      // Jika crossfade skip sedang aktif, transisi ini berasal dari
      // skip() yang sudah menangani queue management. Jangan proses ulang.
      if (this.skipTransitionActive) {
        console.log(`[IDLE:${this.guildId}] skipTransitionActive=true, skipping idle processing (crossfade skip in progress)`);
        this.skipRequested = false;
        this.stopRequested = false;
        this.playbackStartedAt = null;
        clearTimeout(this.crossfadeBufferTimer);
        this.crossfadeBufferTimer = null;
        // Jangan kill process karena crossfade pipeline sudah dipasang
        // Jangan ubah current/queue karena crossfade skip sudah mengaturnya
        return;
      }

      if (this.currentProcess) {
        console.log(`[IDLE:${this.guildId}] Killing currentProcess (pid: ${this.currentProcess.pid})`);
        this.currentProcess.kill("SIGKILL");
        this.currentProcess = null;
      }
      if (this.currentSourceProcess) {
        console.log(`[IDLE:${this.guildId}] Killing currentSourceProcess`);
        this.currentSourceProcess.kill("SIGKILL");
        this.currentSourceProcess = null;
      }

      const finished = this.current;
      const wasSkipped = this.skipRequested;
      const wasStopped = this.stopRequested;
      console.log(`[IDLE:${this.guildId}] Track finished | title=${
        finished ? truncate(finished.title, 80) : 'null'
      } | wasSkipped=${wasSkipped} | wasStopped=${wasStopped} | loopMode=${this.loopMode} | queueBefore=${this.queue.length} | historyBefore=${this.history.length}`);
      this.skipRequested = false;
      this.stopRequested = false;
      this.playbackStartedAt = null;
      clearTimeout(this.crossfadeBufferTimer);
      this.crossfadeBufferTimer = null;
      if (finished) {
        this.consecutiveErrors = 0;
        if (wasStopped) {
          console.log(`[IDLE:${this.guildId}] wasStopped=true, resetting seekSeconds`);
          finished.seekSeconds = 0;
        } else if (wasSkipped) {
          console.log(`[IDLE:${this.guildId}] wasSkipped=true, pushing to history`);
          finished.seekSeconds = 0;
          this.history.push(finished);
          if (this.history.length > 25) {
            this.history = this.history.slice(-25);
          }
        } else {
          console.log(`[IDLE:${this.guildId}] Natural completion, calling handleTrackCompletion`);
          this.handleTrackCompletion(finished);
        }
      }
      this.finishedTrack = finished;
      this.current = null;
      console.log(`[IDLE:${this.guildId}] State after completion | queue=${this.queue.length} | history=${this.history.length} | current=null`);
      if (wasStopped) {
        console.log(`[IDLE:${this.guildId}] wasStopped=true, resetting idle timer and returning`);
        this.skipTransitionActive = false;
        this.resetIdleTimer();
        return;
      }
      // Defensive: pastikan tidak ada watchdog tersisa dari proses sebelumnya
      // yang bisa dipicu oleh kill() di atas sebelum queuePlayNext.
      this.clearPipelineCompletionTimer();
      console.log(`[IDLE:${this.guildId}] Calling queuePlayNext("idle")`);
      await this.queuePlayNext("idle");
    });

    this.player.on("error", async (error) => {
      console.error(`[PLAYER_ERROR:${this.guildId}] Player error event`, error);
      console.log(`[PLAYER_ERROR:${this.guildId}] consecutiveErrors=${this.consecutiveErrors} | current=${this.current ? truncate(this.current.title, 80) : 'null'} | queue=${this.queue.length}`);
      if (this.currentProcess) {
        this.currentProcess.kill("SIGKILL");
        this.currentProcess = null;
      }
      if (this.currentSourceProcess) {
        this.currentSourceProcess.kill("SIGKILL");
        this.currentSourceProcess = null;
      }

      this.consecutiveErrors++;
      const isNetwork = isTransientNetworkError(error);
      const errorMessage = isNetwork
        ? "⚠️ Gangguan jaringan terdeteksi. Mencoba lagi..."
        : `Playback error: ${error.message}. Mencoba lagu berikutnya...`;

      if (this.consecutiveErrors < 3) {
        await this.sendStatusMessage(errorMessage);
        void this.queuePlayNext(isNetwork ? "network-retry" : "error");
      } else {
        this.skipTransitionActive = false;
        await this.sendStatusMessage(
          `Terlalu banyak error berturut-turut. Playback dihentikan.`,
        );
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
      youtubeFailureReason: this.youtubeFailureReason,
    };
  }

  setYoutubeHealthy() {
    this.youtubeStatus = "up";
    this.youtubeFailureReason = null;
  }

  setYoutubeUnavailable(reason) {
    this.youtubeStatus = "down";
    this.youtubeFailureReason = reason || "YouTube sedang bermasalah";
  }

  waitForPlaybackStart(timeoutMs = 5_000) {
    if (
      this.player.state.status === AudioPlayerStatus.Playing ||
      this.player.state.status === AudioPlayerStatus.Paused
    ) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("playback start timeout"));
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

        await this.ytdlp.resolve("ytsearch1:music");
        this.setYoutubeHealthy();
      } catch (error) {
        if (isYoutubeAvailabilityError(error)) {
          this.setYoutubeUnavailable(error.message);
        } else {
          console.warn(
            `[player:${this.guildId}] youtube probe failed:`,
            error.message,
          );
        }
      } finally {
        this.youtubeLastCheckedAt = Date.now();
        this.youtubeProbePromise = null;
        if (this.current) {
          void this.publishNowPlaying("youtube-probe");
        }
      }
    })();

    return this.youtubeProbePromise;
  }

  getYoutubeStatusLabel() {
    if (this.youtubeStatus === "down") {
      return `Error, failover ke cache${this.youtubeFailureReason ? `: ${truncate(this.youtubeFailureReason, 120)}` : ""}`;
    }

    if (this.youtubeStatus === "up") {
      return "Normal";
    }

    return "Belum diperiksa";
  }

  clearPipelineCompletionTimer() {
    clearTimeout(this.pipelineCompletionTimer);
    this.pipelineCompletionTimer = null;
  }

  getElapsedSeconds() {
    if (!this.playbackStartedAt || !this.current) {
      return 0;
    }
    return (Date.now() - this.playbackStartedAt) / 1000 + (this.current.seekSeconds || 0);
  }

  buildCrossfadeFfmpegArgs(currentTrack, nextTrack, currentPosition) {
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error"];

    // First input: current track from current position, hanya ambil CROSSFADE_DURATION detik
    // sehingga acrossfade langsung mulai dari awal (crossfade segera, tidak menunggu lagu habis)
    args.push(
      "-fflags", "+discardcorrupt+genpts",
      "-probesize", "32M",
      "-analyzeduration", "15M",
    );

    if (currentPosition > 0) {
      args.push("-ss", String(currentPosition));
    }

    // Batasi durasi input pertama hanya sepanjang crossfade
    args.push("-t", String(CROSSFADE_DURATION_SECONDS));

    if (!currentTrack.localPath) {
      const headers = this.buildHttpHeaders(currentTrack);
      if (headers) {
        args.push("-headers", headers);
      }
      args.push(
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_on_network_error", "1",
        "-reconnect_on_http_error", "4xx,5xx",
        "-reconnect_delay_max", "5",
      );
    }

    args.push("-i", currentTrack.localPath || currentTrack.streamUrl);

    // Second input: next track dari awal
    args.push(
      "-fflags", "+discardcorrupt+genpts",
      "-probesize", "32M",
      "-analyzeduration", "15M",
    );

    if (!nextTrack.localPath) {
      const nextHeaders = this.buildHttpHeaders(nextTrack);
      if (nextHeaders) {
        args.push("-headers", nextHeaders);
      }
      args.push(
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_on_network_error", "1",
        "-reconnect_on_http_error", "4xx,5xx",
        "-reconnect_delay_max", "5",
      );
    }

    args.push("-i", nextTrack.localPath || nextTrack.streamUrl);

    // Crossfade filter: karena input pertama hanya CROSSFADE_DURATION detik,
    // acrossfade langsung crossfade dari awal (d = CROSSFADE_DURATION)
    // Hasil: 3 detik fading dari track_lama ke track_baru, lalu track_baru lanjut
    args.push(
      "-filter_complex",
      `[0:a][1:a]acrossfade=d=${CROSSFADE_DURATION_SECONDS}:c1=tri:c2=tri[out]`,
      "-map", "[out]",
      "-c:a", "libopus",
      "-application", "audio",
      "-frame_duration", "20",
      "-compression_level", "10",
      "-b:a", "128k",
      "-ar", "48000",
      "-ac", "2",
      "-f", "ogg",
      "pipe:1",
    );

    return args;
  }

  buildFadeInFfmpegArgs(track) {
    const args = this.buildFfmpegArgsForInput(track, "opus", track.localPath ? "local" : "url");
    // Replace or append fade-in filter
    const fadeArgIndex = args.indexOf("-af");
    const fadeFilter = `afade=t=in:ss=0:d=${CROSSFADE_FADE_IN_DURATION_SECONDS}`;
    if (fadeArgIndex >= 0) {
      args[fadeArgIndex + 1] += `,${fadeFilter}`;
    } else {
      args.push("-af", fadeFilter);
    }
    return args;
  }

  async createCrossfadePipeline(currentTrack, nextTrack, currentPosition) {
    const ffmpegArgs = this.buildCrossfadeFfmpegArgs(currentTrack, nextTrack, currentPosition);
    const process = spawn(config.ffmpegPath, ffmpegArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let probeReady = false;
    process.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const startupFailure = new Promise((_, reject) => {
      process.once("error", (error) => {
        reject(new Error(`ffmpeg crossfade spawn failed: ${error.message}`));
      });
      process.once("close", (code) => {
        if (probeReady) return;
        reject(
          new Error(
            code && stderr.trim()
              ? `ffmpeg crossfade exited with code ${code}: ${truncate(stderr.trim(), 500)}`
              : "ffmpeg crossfade berhenti sebelum stream audio siap",
          ),
        );
      });
    });

    const probe = Promise.race([demuxProbe(process.stdout), startupFailure]);

    return {
      process,
      sourceProcess: null,
      probe,
      markProbeReady: () => { probeReady = true; },
      stderr: () => stderr,
    };
  }

  schedulePipelineCompletionAdvance(track, nonce, reason = "pipeline-close") {
    const trackKey = getTrackIdentity(track);
    console.log(`[WATCHDOG:${this.guildId}] Scheduling pipeline watchdog | track="${truncate(track?.title || 'unknown', 80)}" | nonce=${nonce} | reason=${reason} | timeoutMs=${PIPELINE_IDLE_WATCHDOG_MS} | stopRequested=${this.stopRequested} | skipRequested=${this.skipRequested} | currentNonce=${this.playNonce}`);

    if (!trackKey || this.stopRequested) {
      console.log(`[WATCHDOG:${this.guildId}] Skipping: trackKey=${Boolean(trackKey)} stopRequested=${this.stopRequested}`);
      return;
    }

    this.clearPipelineCompletionTimer();
    this.pipelineCompletionTimer = setTimeout(() => {
      this.pipelineCompletionTimer = null;

      if (
        this.stopRequested ||
        this.skipRequested ||
        this.playNonce !== nonce
      ) {
        console.log(`[WATCHDOG:${this.guildId}] Watchdog firing but cancelled: stopReq=${this.stopRequested} skipReq=${this.skipRequested} nonceMatch=${this.playNonce === nonce}`);
        return;
      }

      const currentKey = getTrackIdentity(this.current);
      if (!currentKey || currentKey !== trackKey) {
        console.log(`[WATCHDOG:${this.guildId}] Watchdog firing but track changed or null: currentKey=${currentKey} expected=${trackKey}`);
        return;
      }

      if (this.player.state.status === AudioPlayerStatus.Idle) {
        console.log(`[WATCHDOG:${this.guildId}] Watchdog firing but player already idle`);
        return;
      }

      console.warn(
        `[WATCHDOG:${this.guildId}] FORCING idle transition after ${reason} for "${truncate(track.title, 80)}"`,
      );
      console.log(`[WATCHDOG:${this.guildId}] Calling player.stop(true) to force idle`);
      this.player.stop(true);
    }, PIPELINE_IDLE_WATCHDOG_MS);
  }

  maybeResumePlayback(reason = "queue-update") {
    const blockedByStopRequested = this.stopRequested;
    const blockedByCurrent = Boolean(this.current);
    const blockedByEmptyQueue = this.queue.length === 0;
    const blockedByPlayNextPromise = Boolean(this.playNextPromise);
    const playerStatus = this.player.state.status;

    console.log(`[MAYBE_RESUME:${this.guildId}] reason=${reason} | stopRequested=${blockedByStopRequested} | current=${blockedByCurrent} | queueEmpty=${blockedByEmptyQueue} | playNextPromise=${blockedByPlayNextPromise} | playerStatus=${playerStatus}`);

    if (
      this.stopRequested ||
      this.current ||
      this.queue.length === 0 ||
      this.playNextPromise
    ) {
      console.log(`[MAYBE_RESUME:${this.guildId}] Blocked: stopReq=${blockedByStopRequested} current=${blockedByCurrent} emptyQueue=${blockedByEmptyQueue} hasPromise=${blockedByPlayNextPromise}`);
      return;
    }

    if (this.player.state.status === AudioPlayerStatus.Idle) {
      console.log(`[MAYBE_RESUME:${this.guildId}] Player idle with ${this.queue.length} tracks in queue, calling queuePlayNext`);
      void this.queuePlayNext(reason);
    } else {
      console.log(`[MAYBE_RESUME:${this.guildId}] Player not idle (${playerStatus}), skipping`);
    }
  }

  async buildCacheFallbackTrack({
    requester,
    originalQuery = "Cache Fallback",
    preferredQuery = "",
  } = {}) {
    const excludeCanonicalKeys = new Set([
      this.current?.canonicalKey,
      ...this.queue.map((track) => track.canonicalKey),
      ...this.history.map((track) => track.canonicalKey),
    ]);

    const bestMatch = await this.audioCache.getBestMatchTrack({
      query: preferredQuery || originalQuery,
      excludeCanonicalKeys: [...excludeCanonicalKeys].filter(Boolean),
      requester,
      originalQuery,
    });

    if (bestMatch) {
      return bestMatch;
    }

    return this.audioCache.getAutoplayCandidate({
      excludeCanonicalKeys: [...excludeCanonicalKeys].filter(Boolean),
      requester,
      originalQuery,
    });
  }

  async enqueue({ member, textChannel, query }) {
    console.log(`[ENQUEUE:${this.guildId}] enqueue called | query="${truncate(query, 100)}" | requester=${member.displayName} (${member.id}) | current=${this.current ? truncate(this.current.title, 80) : 'null'} | queue=${this.queue.length} | autoplay=${this.autoplay} | autoplayPreparePromise=${Boolean(this.autoplayPreparePromise)}`);

    this.lastTextChannelId = textChannel.id;
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      throw new Error("Kamu harus berada di voice channel terlebih dahulu");
    }

    const requester = { id: member.id, name: member.displayName };
    const requestStartedAt = Date.now();

    if (!isUrl(query)) {
      console.log(`[ENQUEUE:${this.guildId}] Query is not URL, checking local cache first`);
      const localTrack = await this.audioCache.resolveQueryToTrack(query, {
        requester,
        addedAt: requestStartedAt,
        originalQuery: query,
        requestStartedAt,
      });

      if (localTrack) {
        console.log(`[ENQUEUE:${this.guildId}] Found in local cache: "${truncate(localTrack.title, 80)}"`);
        const isFirstPlay = !this.current;
        await this.ensureVoice(voiceChannel);
        this.insertUserTracks([localTrack]);
        void this.publishNowPlaying("queue-update");

        if (!this.current) {
          console.log(`[ENQUEUE:${this.guildId}] isFirstPlay=${isFirstPlay}, calling queuePlayNext("enqueue")`);
          void this.queuePlayNext("enqueue");
        } else {
          console.log(`[ENQUEUE:${this.guildId}] Not first, preloading upcoming tracks`);
          void this.preloadUpcomingTracks();
        }

        if (isFirstPlay) {
          void this.scheduleYoutubeAvailabilityProbe({
            waitForPlaybackStart: true,
          });
        }

        return {
          type: "single",
          fromCache: true,
          isFirstPlay,
          tracks: [localTrack],
        };
      }

      console.log(`[ENQUEUE:${this.guildId}] Not found in local cache | youtubeStatus=${this.youtubeStatus}`);

      if (this.youtubeStatus === "down") {
        console.log(`[ENQUEUE:${this.guildId}] YouTube is down, trying cache failover`);
        const fallbackTrack = await this.buildCacheFallbackTrack({
          requester,
          originalQuery: `Cache failover untuk: ${query}`,
          preferredQuery: query,
        });

        if (fallbackTrack) {
          console.log(`[ENQUEUE:${this.guildId}] Cache failover track found: "${truncate(fallbackTrack.title, 80)}"`);
          await this.ensureVoice(voiceChannel);
          this.insertUserTracks([fallbackTrack]);
          void this.publishNowPlaying("queue-update");

          if (!this.current) {
            void this.queuePlayNext("enqueue-failover");
          } else {
            void this.preloadUpcomingTracks();
          }

          return {
            type: "single",
            fromCache: true,
            failover: true,
            tracks: [fallbackTrack],
          };
        } else {
          console.log(`[ENQUEUE:${this.guildId}] No cache failover available either, will try YouTube`);
        }
      }
    } else {
      console.log(`[ENQUEUE:${this.guildId}] Query is a URL`);
    }

    this.youtubeStatus = "unknown";
    this.youtubeFailureReason = null;

    // Jalankan join voice + resolve metadata secara paralel (hemat 2-4 detik)
    let resolved;
    try {
      console.log(`[ENQUEUE:${this.guildId}] Resolving query via ytdlp and joining voice...`);
      [, resolved] = await Promise.all([
        this.ensureVoice(voiceChannel),
        this.ytdlp.resolve(query),
      ]);
      console.log(`[ENQUEUE:${this.guildId}] Resolve succeeded | type=${resolved.type} | tracks=${resolved.tracks?.length || 0}`);
      this.setYoutubeHealthy();
    } catch (error) {
      console.error(`[ENQUEUE:${this.guildId}] Resolve failed: ${error.message}`);
      const isYoutubeError = isYoutubeAvailabilityError(error);
      console.log(`[ENQUEUE:${this.guildId}] Error analysis | isYoutubeError=${isYoutubeError}`);

      if (!isYoutubeError) {
        console.log(`[ENQUEUE:${this.guildId}] Non-YouTube error, throwing`);
        throw error;
      }

      console.log(`[ENQUEUE:${this.guildId}] YouTube error, trying cache failover`);
      this.setYoutubeUnavailable(error.message);
      const fallbackTrack = await this.buildCacheFallbackTrack({
        requester,
        originalQuery: `Cache failover untuk: ${query}`,
        preferredQuery: query,
      });

      if (!fallbackTrack) {
        console.error(`[ENQUEUE:${this.guildId}] No cache fallback available, throwing`);
        throw new Error(
          `YouTube sedang error dan cache lokal kosong: ${truncate(error.message || "unknown error", 250)}`,
        );
      }

      console.log(`[ENQUEUE:${this.guildId}] Cache fallback found: "${truncate(fallbackTrack.title, 80)}"`);
      this.insertUserTracks([fallbackTrack]);
      void this.publishNowPlaying("queue-update");

      if (!this.current) {
        console.log(`[ENQUEUE:${this.guildId}] Calling queuePlayNext("enqueue-failover")`);
        void this.queuePlayNext("enqueue-failover");
      } else {
        void this.preloadUpcomingTracks();
      }

      return {
        type: "single",
        fromCache: true,
        failover: true,
        tracks: [fallbackTrack],
      };
    }

    console.log(`[ENQUEUE:${this.guildId}] YouTube resolve succeeded, building tracks`);
    const tracks = resolved.tracks.map((track) => ({
      ...track,
      requester,
      addedAt: Date.now(),
      originalQuery: query,
      requestStartedAt: Date.now(),
    }));

    if (resolved.type === "playlist" && tracks[0]) {
      console.log(`[ENQUEUE:${this.guildId}] Pre-hydrating first playlist track...`);
      try {
        await this.ytdlp.hydrate(tracks[0]);
      } catch (error) {
        console.warn(
          `[ENQUEUE:${this.guildId}] first playlist track pre-hydrate failed: ${error.message}`,
        );
      }
    }

    console.log(`[ENQUEUE:${this.guildId}] Inserting ${tracks.length} tracks into queue`);
    this.insertUserTracks(tracks);
    void this.publishNowPlaying("queue-update");

    const isFirstPlay = !this.current;
    console.log(`[ENQUEUE:${this.guildId}] isFirstPlay=${isFirstPlay} | resolvedTrackCount=${tracks.length} | resolvedType=${resolved.type}`);
    if (!this.current) {
      console.log(`[ENQUEUE:${this.guildId}] No current track, calling queuePlayNext("enqueue")`);
      void this.queuePlayNext("enqueue");
    } else {
      console.log(`[ENQUEUE:${this.guildId}] Current track exists, calling preloadUpcomingTracks`);
      void this.preloadUpcomingTracks();
    }

    if (isFirstPlay) {
      void this.scheduleYoutubeAvailabilityProbe({
        waitForPlaybackStart: true,
      });
    }

    return { ...resolved, tracks, isFirstPlay };
  }

  insertUserTracks(tracks) {
    const autoplayCount = this.queue.filter(t => t.requester?.id === "autoplay").length;
    console.log(`[INSERT_TRACKS:${this.guildId}] Inserting ${tracks.length} user tracks | queueBefore=${this.queue.length} | autoplayInQueue=${autoplayCount} | tracks=${tracks.map(t => truncate(t.title, 50)).join(', ')}`);

    this.shuffleActive = false;

    // Hapus lagu autoplay lama yang sudah mengantre
    const removed = this.queue.filter(
      (track) => track.requester?.id === "autoplay",
    );
    this.queue = this.queue.filter(
      (track) => track.requester?.id !== "autoplay",
    );

    console.log(`[INSERT_TRACKS:${this.guildId}] Removed ${removed.length} autoplay tracks from queue | queueAfterRemove=${this.queue.length}`);

    // Batalkan/reset referensi background promise autoplay lama jika ada
    if (this.autoplaySeedId) {
      console.log(`[INSERT_TRACKS:${this.guildId}] Resetting autoplaySeedId (was ${this.autoplaySeedId})`);
    }
    this.autoplaySeedId = null;

    this.queue.push(...tracks);
    console.log(`[INSERT_TRACKS:${this.guildId}] Queue after push=${this.queue.length}`);
  }

  async ensureVoice(voiceChannel) {
    console.log(`[VOICE:${this.guildId}] ensureVoice | channelId=${voiceChannel.id} | channelName=${voiceChannel.name}`);
    this.voiceChannelId = voiceChannel.id;
    clearTimeout(this.voiceReconnectTimer);
    this.voiceReconnectTimer = null;
    let connection = getVoiceConnection(this.guildId);

    if (connection) {
      const state = connection.state.status;
      // Jika dalam state Disconnected, coba reconnect dulu
      if (state === VoiceConnectionStatus.Disconnected) {
        const reason = connection.state.reason;
        if (
          reason === VoiceConnectionDisconnectReason.WebSocketClose &&
          connection.state.closeCode === 4014
        ) {
          // Kicked from channel — buat koneksi baru
          connection.destroy();
          connection = null;
        } else {
          try {
            // Coba rejoin channel yang sama
            await entersState(
              connection,
              VoiceConnectionStatus.Connecting,
              5_000,
            );
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
        daveEncryption: true,
      });
      connection.subscribe(this.player);

      // Log perubahan state untuk debugging DAVE handshake
      connection.on("stateChange", (oldState, newState) => {
        console.log(
          `[voice:${this.guildId}] ${oldState.status} → ${newState.status}`,
        );
      });
    }

    this.attachConnectionHandlers(connection);

    try {
      // Timeout 30 detik — DAVE handshake membutuhkan lebih banyak waktu
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    } catch (error) {
      connection.destroy();
      const isAborted = error?.message === "The operation was aborted";
      throw new Error(
        isAborted
          ? "Voice connection gagal siap dalam 30 detik. Handshake DAVE/E2EE belum selesai — coba lagi atau hubungi server Discord."
          : `Voice connection gagal: ${error.message}`,
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

    if (
      !this.pausedForVoiceReconnect &&
      this.player.state.status === AudioPlayerStatus.Playing
    ) {
      this.pausedForVoiceReconnect = this.player.pause();
    }

    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      return;
    } catch {
      this.scheduleVoiceReconnect();
    }
  }

  scheduleVoiceReconnect() {
    if (
      this.voiceReconnectPromise ||
      this.voiceReconnectTimer ||
      this.stopRequested ||
      !this.voiceChannelId
    ) {
      return;
    }

    const attempt = this.voiceReconnectAttempts + 1;
    const delayMs = Math.min(
      VOICE_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
      VOICE_RECONNECT_MAX_DELAY_MS,
    );

    this.voiceReconnectTimer = setTimeout(() => {
      this.voiceReconnectTimer = null;
      this.voiceReconnectPromise = this.recoverVoiceConnection(attempt).finally(
        () => {
          this.voiceReconnectPromise = null;
        },
      );
      void this.voiceReconnectPromise;
    }, delayMs);

    if (!this.voiceDisconnectNotified) {
      this.voiceDisconnectNotified = true;
      void this.sendStatusMessage(
        "Koneksi voice terputus. Bot akan mencoba reconnect otomatis.",
      );
    }
  }

  async recoverVoiceConnection(attempt = this.voiceReconnectAttempts + 1) {
    if (!this.voiceChannelId) {
      return;
    }

    const channel = await this.client.channels
      .fetch(this.voiceChannelId)
      .catch(() => null);
    if (!channel?.isVoiceBased?.()) {
      this.voiceReconnectAttempts = 0;
      this.pausedForVoiceReconnect = false;
      await this.sendStatusMessage(
        "Voice channel tidak ditemukan untuk reconnect otomatis.",
      );
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
      await this.sendStatusMessage(
        "Koneksi voice terputus. Berhasil reconnect otomatis.",
      );
    } catch (error) {
      const shouldRetry =
        attempt < VOICE_RECONNECT_MAX_ATTEMPTS && !this.stopRequested;
      if (shouldRetry) {
        await this.sendStatusMessage(
          `Reconnect voice otomatis gagal (${attempt}/${VOICE_RECONNECT_MAX_ATTEMPTS}): ${truncate(error.message || "unknown error", 160)}. Akan coba lagi.`,
        );
        this.scheduleVoiceReconnect();
        return;
      }

      this.pausedForVoiceReconnect = false;
      await this.sendStatusMessage(
        `Reconnect voice otomatis gagal setelah ${attempt} percobaan: ${truncate(error.message || "unknown error", 300)}. Gunakan /reconnect atau /play lagi.`,
      );
    }
  }

  resetIdleTimer() {
    clearTimeout(this.idleTimeout);
    this.idleTimeout = setTimeout(() => {
      void this.sendStatusMessage(
        "Tidak ada lagu yang diputar selama 3 menit. Bot disconnect otomatis.",
      );
      void this.stop({ disconnect: true });
    }, config.defaultIdleTimeoutMs);
  }

  clearEmptyChannelTimeout() {
    clearTimeout(this.emptyChannelTimeout);
    this.emptyChannelTimeout = null;
  }

  scheduleEmptyChannelTimeout() {
    if (
      this.emptyChannelTimeout ||
      !this.voiceChannelId ||
      this.stopRequested
    ) {
      return;
    }

    this.emptyChannelTimeout = setTimeout(() => {
      this.emptyChannelTimeout = null;
      void this.sendStatusMessage(
        "Tidak ada listener di voice channel selama 3 menit. Playback dihentikan dan bot disconnect.",
      );
      void this.stop({ disconnect: true });
    }, config.emptyChannelTimeoutMs);
  }

  async refreshEmptyChannelTimeout() {
    if (!this.voiceChannelId) {
      this.clearEmptyChannelTimeout();
      return;
    }

    const channel = await this.client.channels
      .fetch(this.voiceChannelId)
      .catch(() => null);
    if (!channel?.isVoiceBased?.()) {
      this.clearEmptyChannelTimeout();
      return;
    }

    const hasHumanListener = channel.members?.some(
      (member) => !member.user?.bot,
    );
    if (hasHumanListener) {
      this.clearEmptyChannelTimeout();
      return;
    }

    this.scheduleEmptyChannelTimeout();
  }

  handleTrackCompletion(track) {
    console.log(`[TRACK_COMPLETE:${this.guildId}] Track completed naturally | title=${
      truncate(track.title, 80)
    } | loopMode=${this.loopMode} | queueBefore=${this.queue.length} | historyBefore=${this.history.length}`);

    if (this.loopMode === "track") {
      console.log(`[TRACK_COMPLETE:${this.guildId}] loopMode=track, unshifting clone back to queue`);
      this.queue.unshift(cloneTrack(track));
    } else if (this.loopMode === "queue") {
      console.log(`[TRACK_COMPLETE:${this.guildId}] loopMode=queue, pushing clone to end of queue`);
      this.queue.push(cloneTrack(track));
    } else {
      console.log(`[TRACK_COMPLETE:${this.guildId}] loopMode=off, not re-adding to queue`);
    }

    track.seekSeconds = 0;
    this.history.push(track);
    if (this.history.length > 25) {
      this.history = this.history.slice(-25);
    }
    if (this.queue.length <= 1) {
      this.shuffleActive = false;
    }
    console.log(`[TRACK_COMPLETE:${this.guildId}] After completion | queue=${this.queue.length} | history=${this.history.length} | shuffleActive=${this.shuffleActive}`);
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
        new ButtonBuilder()
          .setCustomId("player:toggle")
          .setLabel("Pause")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId("player:skip")
          .setLabel("Skip")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId("player:stop")
          .setLabel("Stop")
          .setStyle(ButtonStyle.Danger)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId("player:shuffle")
          .setLabel("Shuffle")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("player:autoplay")
          .setLabel("Autoplay")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId("player:loop")
          .setLabel("Loop")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId("player:queue")
          .setLabel("Queue")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId("player:lyrics")
          .setLabel("Lyrics")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
      ),
    ];
  }

  async publishIdleMessage() {
    console.log(`[PUBLISH:${this.guildId}] publishIdleMessage called | lastTextChannelId=${this.lastTextChannelId || 'null'} | queue=${this.queue.length} | current=${Boolean(this.current)} | autoplay=${this.autoplay}`);
    const runUpdate = async () => {
      if (!this.lastTextChannelId) {
        console.log(`[PUBLISH:${this.guildId}] No lastTextChannelId, skipping idle message`);
        return;
      }
      const channel = await this.client.channels
        .fetch(this.lastTextChannelId)
        .catch(() => null);
      if (!channel?.isTextBased()) {
        console.log(`[PUBLISH:${this.guildId}] Channel not text-based or not found`);
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setAuthor({ name: "Player Idle" })
        .setTitle("Tidak ada lagu yang sedang diputar")
        .setDescription(
          [
            "Queue habis dan tidak ada lagu berikutnya yang bisa diputar.",
            "",
            `Bot akan disconnect otomatis dalam <t:${nowUnixPlus(Math.floor(config.emptyChannelTimeoutMs / 1000))}:R> jika belum ada lagu lagi.`,
          ].join("\n"),
        );
      const components = this.buildDisabledControlRows();

      if (this.currentMessage) {
        try {
          this.currentMessage = await this.currentMessage.edit({
            embeds: [embed],
            components,
          });
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
    console.log(`[PRELOAD:${this.guildId}] preloadUpcomingTracks | nextTrack=${nextTrack ? truncate(nextTrack.title, 80) : 'null'} | inFlight=${nextTrack?.id ? this.preloadInFlight.has(nextTrack.id) : 'N/A'} | queue=${this.queue.length}`);

    if (!nextTrack?.id || this.preloadInFlight.has(nextTrack.id)) {
      console.log(`[PRELOAD:${this.guildId}] Skipping: no nextTrack or already in flight`);
      return;
    }

    this.preloadInFlight.add(nextTrack.id);
    console.log(`[PRELOAD:${this.guildId}] Preloading track "${truncate(nextTrack.title, 80)}" (id=${nextTrack.id})`);
    try {
      await this.prepareTrackForPlayback(nextTrack, {
        trigger: "preload",
        allowBackgroundDownload: true,
      });
      console.log(`[PRELOAD:${this.guildId}] Preload successful for "${truncate(nextTrack.title, 80)}"`);
    } catch (error) {
      console.warn(
        `[PRELOAD:${this.guildId}] preload failed for ${nextTrack.title}: ${error.message}`,
      );
    } finally {
      this.preloadInFlight.delete(nextTrack.id);
      console.log(`[PRELOAD:${this.guildId}] Preload finished for id=${nextTrack.id}`);
    }
  }

  getTrackCacheStatusLabel(track) {
    if (!track) {
      return "Tidak diketahui";
    }

    if (track.localPath) {
      return "Diputar dari cache lokal";
    }

    switch (track.cacheStatus) {
      case "downloading":
        return "Streaming + download cache berjalan";
      case "cached":
        return "Tersimpan di cache";
      case "failed":
        return `Download cache gagal${track.cacheError ? `: ${truncate(track.cacheError, 80)}` : ""}`;
      case "queued":
        return "Menunggu download cache";
      case "skipped":
        return track.cacheError
          ? `Cache dilewati: ${truncate(track.cacheError, 80)}`
          : "Cache tidak dijalankan";
      default:
        return "Streaming langsung";
    }
  }

  async syncCurrentMessageIfTrack(track) {
    if (!this.current || !track) {
      return;
    }

    const currentKey =
      this.current.canonicalKey ||
      this.current.id ||
      this.current.webpageUrl ||
      this.current.title;
    const trackKey =
      track.canonicalKey || track.id || track.webpageUrl || track.title;
    if (currentKey !== trackKey) {
      return;
    }

    await this.publishNowPlaying("cache-update");
  }

  queueCacheDownload(track) {
    if (!track || track.localPath) {
      return;
    }

    if (track.duration > config.audioCacheMaxDurationSeconds) {
      track.cacheStatus = "skipped";
      track.cacheError = `durasi > ${Math.floor(config.audioCacheMaxDurationSeconds / 60)} menit`;
      void this.syncCurrentMessageIfTrack(track);
      return;
    }

    track.cacheStatus = "downloading";
    track.cacheError = null;
    void this.syncCurrentMessageIfTrack(track);

    void this.audioCache
      .queueDownload(track)
      .then(async (entry) => {
        if (!entry) {
          track.cacheStatus = "failed";
          track.cacheError ??= "download tidak berhasil";
          await this.syncCurrentMessageIfTrack(track);
          return;
        }

        track.cacheStatus = "cached";
        track.cacheError = null;
        await this.syncCurrentMessageIfTrack(track);
      })
      .catch(async (error) => {
        track.cacheStatus = "failed";
        track.cacheError = error.message;
        await this.syncCurrentMessageIfTrack(track);
      });
  }

  async prepareTrackForPlayback(
    track,
    { trigger = "play", allowBackgroundDownload = true } = {},
  ) {
    console.log(`[PREPARE:${this.guildId}] prepareTrackForPlayback | title="${truncate(track?.title || 'unknown', 80)}" | trigger=${trigger} | allowBgDownload=${allowBackgroundDownload} | localPath=${Boolean(track?.localPath)} | streamUrl=${Boolean(track?.streamUrl)} | youtubeStatus=${this.youtubeStatus} | metadataPending=${track?.metadataPending}`);

    if (track.localPath) {
      console.log(`[PREPARE:${this.guildId}] Already has localPath, using cache`);
      track.cacheStatus = "cached";
      track.cacheError = null;
      return track;
    }

    console.log(`[PREPARE:${this.guildId}] Checking audio cache for local reference...`);
    await this.audioCache.hydrateLocalReference(track);

    if (track.localPath) {
      console.log(`[PREPARE:${this.guildId}] Found in audio cache: ${track.localPath}`);
      track.cacheStatus = "cached";
      track.cacheError = null;
      return track;
    }

    console.log(`[PREPARE:${this.guildId}] Not in cache, need stream URL`);

    if (this.youtubeStatus === "down") {
      console.error(`[PREPARE:${this.guildId}] YouTube is down, throwing`);
      throw new Error(
        "YouTube sedang error, playback dibatasi ke lagu cache lokal.",
      );
    }

    if (track.metadataPending) {
      console.log(`[PREPARE:${this.guildId}] Track has pending metadata, hydrating...`);
      await this.ytdlp.hydrateMetadata(track);
      console.log(`[PREPARE:${this.guildId}] Metadata hydrated`);
    }

    console.log(`[PREPARE:${this.guildId}] Ensuring stream URL...`);
    await this.ytdlp.ensureStreamUrl(track);
    console.log(`[PREPARE:${this.guildId}] Stream URL ready | streamUrl=${Boolean(track.streamUrl)}`);

    if (allowBackgroundDownload) {
      console.log(`[PREPARE:${this.guildId}] Queueing cache download in background`);
      this.queueCacheDownload(track);
    } else {
      track.cacheStatus = "skipped";
    }

    return track;
  }

  async prepareAutoplayTrack() {
    const seed = this.current || this.history[this.history.length - 1];
    const seedKey = getTrackIdentity(seed);
    console.log(`[AUTOPLAY:${this.guildId}] prepareAutoplayTrack called | autoplay=${this.autoplay} | seed=${seed ? truncate(seed.title, 80) : 'null'} | seedKey=${seedKey || 'null'} | queue=${this.queue.length} | current=${this.current ? truncate(this.current.title, 80) : 'null'} | historyLast=${this.history.length > 0 ? truncate(this.history[this.history.length-1].title, 50) : 'none'} | autoplayPreparePromise=${Boolean(this.autoplayPreparePromise)} | autoplaySeedId=${this.autoplaySeedId || 'null'}`);

    if (!this.autoplay || !seed) {
      console.log(`[AUTOPLAY:${this.guildId}] Skipping: autoplay=${this.autoplay} seed=${Boolean(seed)}`);
      return;
    }

    if (this.queue.length > 0) {
      console.log(`[AUTOPLAY:${this.guildId}] Queue has ${this.queue.length} tracks, preloading instead of autoplay`);
      await this.preloadUpcomingTracks();
      return;
    }

    const hasAutoplayQueued = this.queue.some(
      (track) => track.requester?.id === "autoplay",
    );
    if (hasAutoplayQueued) {
      console.log(`[AUTOPLAY:${this.guildId}] Autoplay track already queued, skipping`);
      return;
    }

    if (this.autoplayPreparePromise && this.autoplaySeedId === seedKey) {
      console.log(`[AUTOPLAY:${this.guildId}] Waiting for existing autoplayPreparePromise with same seedKey`);
      await this.autoplayPreparePromise;
      // Cek apakah promise tadi benar-benar menghasilkan track di queue
      const gotTrack = this.queue.some(
        (track) => track.requester?.id === "autoplay",
      );
      if (gotTrack) {
        console.log(`[AUTOPLAY:${this.guildId}] Existing promise added track, queue now has ${this.queue.length} tracks`);
        return;
      }
      // Promise selesai tapi gagal push track — reset state dan lanjut retry
      this.autoplayPreparePromise = null;
      this.autoplaySeedId = null;
      console.log(`[AUTOPLAY:${this.guildId}] autoplay promise selesai tanpa hasil, retry...`);
    }

    this.autoplaySeedId = seedKey;
    console.log(`[AUTOPLAY:${this.guildId}] Starting autoplay preparation | seedKey=${seedKey} | youtubeStatus=${this.youtubeStatus}`);

    this.autoplayPreparePromise = (async () => {
      try {
        const enqueueCacheAutoplay = async (
          originalQuery = "Cache Autoplay",
        ) => {
          console.log(`[AUTOPLAY:${this.guildId}] Trying cache autoplay | originalQuery="${originalQuery}" | seedKey=${seedKey}`);
          const cached = await this.buildCacheFallbackTrack({
            requester: { id: "autoplay", name: "Autoplay Cache" },
            originalQuery,
            preferredQuery: `${seed.title || ""} ${seed.uploader || ""}`.trim(),
          });

          if (cached && this.autoplaySeedId === seedKey) {
            console.log(`[AUTOPLAY:${this.guildId}] Cache autoplay found track: "${truncate(cached.title, 80)}"`);
            this.queue.push(cached);
            this.shuffleActive = false;
            void this.publishNowPlaying("queue-update");
            console.log(`[AUTOPLAY:${this.guildId}] Calling maybeResumePlayback after cache autoplay`);
            this.maybeResumePlayback("autoplay-cache-ready");
          } else {
            console.log(`[AUTOPLAY:${this.guildId}] Cache autoplay: no track found or seedId changed | cached=${Boolean(cached)} seedIdMatch=${this.autoplaySeedId === seedKey}`);
          }
          return Boolean(cached);
        };

        if (this.youtubeStatus === "down") {
          console.log(`[AUTOPLAY:${this.guildId}] YouTube is down, trying cache`);
          await enqueueCacheAutoplay("Cache Autoplay");
          return;
        }

        if (needsAutoplaySeedHydration(seed)) {
          console.log(`[AUTOPLAY:${this.guildId}] Seed needs hydration, calling hydrateMetadata`);
          await this.ytdlp.hydrateMetadata(seed);
          console.log(`[AUTOPLAY:${this.guildId}] Seed hydrated`);
        }

        let query;
        if (seed.source === "youtube" && seed.id && seed.id.length === 11) {
          query = `https://www.youtube.com/watch?v=${seed.id}&list=RD${seed.id}`;
          console.log(`[AUTOPLAY:${this.guildId}] Using YouTube mix query for autoplay: ${query}`);
        } else {
          query = `ytsearch5:${seed.uploader || seed.title} best hits audio`;
          console.log(`[AUTOPLAY:${this.guildId}] Using search query for autoplay: ${query}`);
        }

        console.log(`[AUTOPLAY:${this.guildId}] Resolving autoplay query...`);
        const auto = await this.ytdlp.resolve(query);
        console.log(`[AUTOPLAY:${this.guildId}] Resolve returned ${auto.tracks.length} tracks`);

        const candidates = auto.tracks.filter(
          (t) => t.id !== seed.id && !this.history.some((h) => h.id === t.id),
        );
        console.log(`[AUTOPLAY:${this.guildId}] Filtered candidates: ${candidates.length} tracks (excluded seed and history)`);

        const chosen =
          candidates.length > 0
            ? candidates[
                Math.floor(Math.random() * Math.min(candidates.length, 5))
              ]
            : auto.tracks[0];

        if (!chosen) {
          console.log(`[AUTOPLAY:${this.guildId}] No track chosen from autoplay results`);
          return;
        }

        console.log(`[AUTOPLAY:${this.guildId}] Chosen track: "${truncate(chosen.title, 80)}" (id=${chosen.id})`);

        const prepared = {
          ...chosen,
          requester: { id: "autoplay", name: "Autoplay" },
          addedAt: Date.now(),
          originalQuery: "Autoplay Suggestion",
        };

        console.log(`[AUTOPLAY:${this.guildId}] Hydrating chosen track...`);
        await this.ytdlp.hydrate(prepared);
        console.log(`[AUTOPLAY:${this.guildId}] Track hydrated | localPath=${Boolean(prepared.localPath)} | streamUrl=${Boolean(prepared.streamUrl)}`);

        // Abaikan push jika referensi seed sudah di-reset oleh enqueue manual user
        if (this.autoplaySeedId !== seedKey) {
          console.log(`[AUTOPLAY:${this.guildId}] seedId changed after hydration, aborting push | expected=${seedKey} actual=${this.autoplaySeedId}`);
          return;
        }

        const isDuplicate = (track) => {
          if (track.id && prepared.id && track.id === prepared.id) return true;
          if (
            track.canonicalKey &&
            prepared.canonicalKey &&
            track.canonicalKey === prepared.canonicalKey
          )
            return true;
          return false;
        };

        const existsInQueue = this.queue.some(isDuplicate);
        const existsInHistory = this.history.some(isDuplicate);
        const isCurrent = this.current && isDuplicate(this.current);

        console.log(`[AUTOPLAY:${this.guildId}] Duplicate check | inQueue=${existsInQueue} | inHistory=${existsInHistory} | isCurrent=${isCurrent}`);

        if (!existsInQueue && !existsInHistory && !isCurrent) {
          console.log(`[AUTOPLAY:${this.guildId}] Pushing autoplay track to queue | queueBefore=${this.queue.length}`);
          this.queue.push(prepared);
          this.shuffleActive = false;
          void this.publishNowPlaying("queue-update");
          console.log(`[AUTOPLAY:${this.guildId}] Calling maybeResumePlayback | queueAfter=${this.queue.length} | playerStatus=${this.player.state.status}`);
          this.maybeResumePlayback("autoplay-ready");
        } else {
          console.log(`[AUTOPLAY:${this.guildId}] Track is duplicate, not adding to queue`);
        }
      } catch (error) {
        console.error(`[AUTOPLAY:${this.guildId}] autoplay prepare error:`, error.message);
        const canFailoverToCache =
          isYoutubeAvailabilityError(error) ||
          isTransientNetworkError(error) ||
          this.youtubeStatus === "down";

        console.log(`[AUTOPLAY:${this.guildId}] Error analysis | canFailoverToCache=${canFailoverToCache} | isYoutubeError=${isYoutubeAvailabilityError(error)} | isNetworkError=${isTransientNetworkError(error)} | youtubeStatus=${this.youtubeStatus}`);

        if (canFailoverToCache) {
          this.setYoutubeUnavailable(error.message);
          console.log(`[AUTOPLAY:${this.guildId}] Trying cache failover after error`);
          const enqueued = await this.buildCacheFallbackTrack({
            requester: { id: "autoplay", name: "Autoplay Cache" },
            originalQuery: `Cache failover autoplay: ${seed.title || "Unknown"}`,
            preferredQuery: `${seed.title || ""} ${seed.uploader || ""}`.trim(),
          });

          if (enqueued && this.autoplaySeedId === seedKey) {
            console.log(`[AUTOPLAY:${this.guildId}] Cache failover track found: "${truncate(enqueued.title, 80)}"`);
            this.queue.push(enqueued);
            this.shuffleActive = false;
            void this.publishNowPlaying("queue-update");
            console.log(`[AUTOPLAY:${this.guildId}] Calling maybeResumePlayback after cache failover`);
            this.maybeResumePlayback("autoplay-failover-ready");
            return;
          } else {
            console.log(`[AUTOPLAY:${this.guildId}] Cache failover: no track found or seedId changed`);
          }
        }

        console.warn(
          `[AUTOPLAY:${this.guildId}] autoplay prepare failed:`,
          error.message,
        );
      } finally {
        if (this.autoplaySeedId === seedKey || this.autoplaySeedId === null) {
          console.log(`[AUTOPLAY:${this.guildId}] Cleaning up autoplayPreparePromise | seedIdMatch=${this.autoplaySeedId === seedKey} | seedIdIsNull=${this.autoplaySeedId === null}`);
          this.autoplayPreparePromise = null;
        } else {
          console.log(`[AUTOPLAY:${this.guildId}] NOT cleaning up promise - seedId changed | current=${this.autoplaySeedId} | expected=${seedKey}`);
        }
      }
    })();

    console.log(`[AUTOPLAY:${this.guildId}] Waiting for autoplayPreparePromise to complete...`);
    await this.autoplayPreparePromise;
    console.log(`[AUTOPLAY:${this.guildId}] autoplayPreparePromise completed | queue=${this.queue.length}`);
  }

  async queuePlayNext(reason = "manual") {
    console.log(`[QUEUE_NEXT:${this.guildId}] queuePlayNext called | reason=${reason} | hasExistingPromise=${Boolean(this.playNextPromise)} | queue=${this.queue.length} | current=${Boolean(this.current)} | stopRequested=${this.stopRequested}`);

    const previous = this.playNextPromise || Promise.resolve();
    const nextRun = previous.then(
      () => this.playNext(reason),
      () => this.playNext(reason),
    );
    this.playNextPromise = nextRun.finally(() => {
      if (this.playNextPromise === nextRun) {
        console.log(`[QUEUE_NEXT:${this.guildId}] playNextPromise cleared after completion (reason=${reason})`);
        this.playNextPromise = null;
      }
    });
    return this.playNextPromise;
  }

  async playNext(reason = "manual") {
    console.log(`[PLAYNEXT:${this.guildId}] playNext called | reason=${reason} | queue=${this.queue.length} | current=${this.current ? truncate(this.current.title, 80) : 'null'} | autoplay=${this.autoplay} | sleepUntil=${this.sleepUntil ? new Date(this.sleepUntil).toISOString() : 'null'} | stopRequested=${this.stopRequested} | consecutiveErrors=${this.consecutiveErrors}`);

    clearTimeout(this.idleTimeout);
    this.clearPipelineCompletionTimer();

    if (this.sleepUntil && Date.now() >= this.sleepUntil) {
      console.log(`[PLAYNEXT:${this.guildId}] Sleep timer expired, stopping`);
      await this.stop({ disconnect: true });
      return;
    }

    if (this.queue.length === 0 && this.autoplay) {
      console.log(`[PLAYNEXT:${this.guildId}] Queue empty with autoplay=true | autoplayPreparePromise=${Boolean(this.autoplayPreparePromise)} | autoplaySeedId=${this.autoplaySeedId || 'null'}`);
      // Jika masih ada background autoplay preparation dari toggleAutoplay(), tunggu dulu
      if (this.autoplayPreparePromise) {
        console.log(`[PLAYNEXT:${this.guildId}] Waiting for existing autoplayPreparePromise...`);
        await this.autoplayPreparePromise;
        console.log(`[PLAYNEXT:${this.guildId}] autoplayPreparePromise resolved | queue after=${this.queue.length}`);
      }
      // Jika background task gagal menambahkan track, coba prepare dari sini
      if (this.queue.length === 0) {
        console.log(`[PLAYNEXT:${this.guildId}] Queue still empty after waiting, calling prepareAutoplayTrack directly`);
        this.autoplaySeedId = null;
        await this.prepareAutoplayTrack();
        console.log(`[PLAYNEXT:${this.guildId}] prepareAutoplayTrack finished | queue=${this.queue.length}`);
      } else {
        console.log(`[PLAYNEXT:${this.guildId}] Queue has ${this.queue.length} tracks after waiting for autoplay promise`);
      }
    } else {
      console.log(`[PLAYNEXT:${this.guildId}] No autoplay needed: queueEmpty=${this.queue.length === 0} autoplay=${this.autoplay}`);
    }

    const next = this.queue.shift();
    this.current = next || null;
    console.log(`[PLAYNEXT:${this.guildId}] Next track: ${next ? truncate(next.title, 80) : 'null'} | queueAfterShift=${this.queue.length}`);

    if (!next) {
      console.log(`[PLAYNEXT:${this.guildId}] No next track, publishing idle message`);
      this.skipTransitionActive = false;
      await this.publishIdleMessage();
      this.resetIdleTimer();
      return;
    }

    this.playNonce += 1;
    const nonce = this.playNonce;
    console.log(`[PLAYNEXT:${this.guildId}] Start processing track | nonce=${nonce} | title="${truncate(next.title, 80)}" | localPath=${Boolean(next.localPath)} | streamUrl=${Boolean(next.streamUrl)} | metadataPending=${next.metadataPending} | seekSeconds=${next.seekSeconds} | requester=${next.requester?.name || 'unknown'}`);

    const metrics = {
      requestStartedAt: next.requestStartedAt || next.addedAt || Date.now(),
      playNextStartedAt: Date.now(),
      hydrateMs: 0,
      pipelineMs: 0,
      logged: false,
    };

    try {
      // Jika track ini sedang di-preload oleh preloadUpcomingTracks(),
      // tunggu preload selesai dulu (maks 30 detik) supaya tidak terjadi
      // dua panggilan yt-dlp bersamaan untuk track yang sama.
      if (next.id && this.preloadInFlight.has(next.id)) {
        console.log(`[PLAYNEXT:${this.guildId}] Track is being preloaded, waiting for preload to finish...`);
        const waitStart = Date.now();
        while (this.preloadInFlight.has(next.id)) {
          if (Date.now() - waitStart > 30_000) {
            console.warn(
              `[PLAYNEXT:${this.guildId}] preload for "${truncate(next.title, 80)}" taking too long, proceeding anyway`,
            );
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        console.log(`[PLAYNEXT:${this.guildId}] Preload wait finished | waited=${Date.now() - waitStart}ms`);
      }

      const hydrateStartedAt = Date.now();
      console.log(`[PLAYNEXT:${this.guildId}] Calling prepareTrackForPlayback | trigger=${reason} | allowBackgroundDownload=true`);
      await withTimeout(
        this.prepareTrackForPlayback(next, {
          trigger: reason,
          allowBackgroundDownload: true,
        }),
        TRACK_PREPARE_TIMEOUT_MS,
        "persiapan track",
      );
      metrics.hydrateMs = Date.now() - hydrateStartedAt;
      console.log(`[PLAYNEXT:${this.guildId}] prepareTrackForPlayback done | hydrateMs=${metrics.hydrateMs}ms | localPath=${Boolean(next.localPath)} | streamUrl=${Boolean(next.streamUrl)} | cacheStatus=${next.cacheStatus || 'none'}`);

      const pipelineStartedAt = Date.now();
      const useFadeIn = Boolean(this.finishedTrack) && reason === "idle";
      console.log(`[PLAYNEXT:${this.guildId}] Creating audio pipeline | useFadeIn=${useFadeIn} | finishedTrack=${Boolean(this.finishedTrack)} | reason=${reason}`);
      // Lepas referensi finishedTrack sebelum buat pipeline agar tidak
      // terjadi referensi silang dengan proses sebelumnya.
      this.finishedTrack = null;
      const prepared = await withTimeout(
        this.createAudioPipeline(next, useFadeIn),
        PIPELINE_CREATE_TIMEOUT_MS,
        "pembuatan audio pipeline",
      );
      metrics.pipelineMs = Date.now() - pipelineStartedAt;
      console.log(`[PLAYNEXT:${this.guildId}] Pipeline created | pipelineMs=${metrics.pipelineMs}ms`);

      if (nonce !== this.playNonce) {
        console.log(`[PLAYNEXT:${this.guildId}] Nonce mismatch (expected=${nonce}, actual=${this.playNonce}), killing pipeline`);
        prepared.process.kill("SIGKILL");
        prepared.sourceProcess?.kill("SIGKILL");
        return;
      }

      if (this.currentProcess) {
        console.log(`[PLAYNEXT:${this.guildId}] Killing old currentProcess`);
        this.currentProcess.kill("SIGKILL");
      }
      if (this.currentSourceProcess) {
        console.log(`[PLAYNEXT:${this.guildId}] Killing old currentSourceProcess`);
        this.currentSourceProcess.kill("SIGKILL");
      }

      this.clearLyricMessages();
      this.currentProcess = prepared.process;
      this.currentSourceProcess = prepared.sourceProcess || null;
      this.currentMetrics = metrics;
      prepared.process.once("close", () => {
        console.log(`[PLAYNEXT:${this.guildId}] ffmpeg process closed for nonce=${nonce}`);
        this.schedulePipelineCompletionAdvance(next, nonce, "ffmpeg-close");
      });
      console.log(`[PLAYNEXT:${this.guildId}] Calling player.play() with resource for "${truncate(next.title, 80)}"`);
      this.player.play(prepared.resource);
      await this.publishNowPlaying(reason);
      void this.preloadUpcomingTracks();
      if (this.autoplay && this.queue.length === 0) {
        console.log(`[PLAYNEXT:${this.guildId}] Autoplay on and queue empty after play, triggering prepareAutoplayTrack`);
        void this.prepareAutoplayTrack();
      } else {
        console.log(`[PLAYNEXT:${this.guildId}] No autoplay needed: autoplay=${this.autoplay} queue=${this.queue.length}`);
      }
    } catch (error) {
      console.error(`[PLAYNEXT:${this.guildId}] playNext failed for "${truncate(next?.title || 'unknown', 80)}":`, error.message);
      console.log(`[PLAYNEXT:${this.guildId}] Error details | consecutiveErrors=${this.consecutiveErrors} | isYoutubeError=${isYoutubeAvailabilityError(error)} | isNetworkError=${isTransientNetworkError(error)}`);
      if (isYoutubeAvailabilityError(error) || isTransientNetworkError(error)) {
        const isNetwork = isTransientNetworkError(error);
        if (isNetwork) {
          await this.sendStatusMessage(
            "⚠️ Gangguan jaringan terdeteksi saat menyiapkan lagu. Mencoba beralih ke cache...",
          );
        }

        this.setYoutubeUnavailable(error.message);
        const fallbackTrack = await this.buildCacheFallbackTrack({
          requester: next.requester || {
            id: "autoplay",
            name: "Cache Failover",
          },
          originalQuery: `Cache failover untuk: ${next.title}`,
          preferredQuery:
            `${next.title || ""} ${next.uploader || ""} ${next.originalQuery || ""}`.trim(),
        });

        if (fallbackTrack) {
          if (!isNetwork) {
            await this.sendStatusMessage(
              "YouTube sedang error. Bot beralih memutar lagu dari cache lokal yang tersedia.",
            );
          }
          this.current = null;
          this.queue.unshift(fallbackTrack);
          void this.queuePlayNext("youtube-failover");
          return;
        }
      }
      this.consecutiveErrors++;

      if (this.consecutiveErrors < 3) {
        const isNetwork = isTransientNetworkError(error);
        await this.sendStatusMessage(
          isNetwork
            ? "⚠️ Gagal memutar karena gangguan jaringan. Mencoba lagu berikutnya..."
            : `Gagal memutar "${next.title}": ${error.message}. Melewati...`,
        );
        // Tunggu sebentar sebelum skip otomatis untuk menghindari spam API gila-gilaan
        await new Promise((r) => setTimeout(r, 2000));
        void this.queuePlayNext("fallback");
        return;
      } else {
        await this.sendStatusMessage(
          `❌ Terjadi kesalahan berulang (${this.consecutiveErrors}x). Menghentikan playback.`,
        );
        await this.stop();
      }
    }
  }

  buildHttpHeaders(track) {
    const headers = { ...(track.httpHeaders || {}) };

    if (track.webpageUrl && /^https?:\/\//.test(track.webpageUrl)) {
      headers.Referer ??= track.webpageUrl;
    }

    headers.Origin ??= "https://www.youtube.com";
    headers["User-Agent"] ??=
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

    return Object.entries(headers)
      .filter(
        ([, value]) =>
          value !== null && value !== undefined && String(value).length > 0,
      )
      .map(([key, value]) => `${key}: ${value}\r\n`)
      .join("");
  }

  buildFfmpegArgs(track, profile = "opus") {
    return this.buildFfmpegArgsForInput(track, profile, "url");
  }

  buildFfmpegArgsForInput(track, profile = "opus", inputMode = "url") {
    const headers = inputMode === "url" ? this.buildHttpHeaders(track) : "";
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error"];

    if (inputMode === "local") {
      args.push(
        "-fflags",
        "+genpts",
        "-probesize",
        "4M",
        "-analyzeduration",
        "2M",
      );
    } else {
      args.push(
        "-fflags",
        "+discardcorrupt+genpts",
        "-probesize",
        "32M",
        "-analyzeduration",
        "15M",
      );
    }

    if (inputMode === "url" || inputMode === "local") {
      args.push(
        ...(track.seekSeconds > 0 ? ["-ss", String(track.seekSeconds)] : []),
      );

      if (inputMode === "url") {
        args.push(
          "-reconnect",
          "1",
          "-reconnect_streamed",
          "1",
          "-reconnect_on_network_error",
          "1",
          "-reconnect_on_http_error",
          "4xx,5xx",
          "-reconnect_delay_max",
          "5",
        );
      }

      if (headers) {
        args.push("-headers", headers);
      }
    }

    args.push(
      "-i",
      inputMode === "stdin"
        ? "pipe:0"
        : inputMode === "local"
          ? track.localPath
          : track.streamUrl,
      "-vn",
      "-sn",
      "-dn",
      "-map",
      "a?",
      "-af",
      "aresample=async=1:min_hard_comp=0.100:first_pts=0",
    );

    if (profile === "pcm") {
      args.push("-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1");
      return args;
    }

    args.push(
      "-c:a",
      "libopus",
      "-application",
      "audio",
      "-frame_duration",
      "20",
      "-compression_level",
      "10",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-f",
      "ogg",
      "pipe:1",
    );
    return args;
  }

  buildYtDlpPipeArgs(track) {
    const target =
      track.webpageUrl || track.url || track.searchQuery || track.title;
    const args = [
      "--default-search",
      config.defaultSearchPlatform,
      "--no-warnings",
      "--no-progress",
      "--skip-download",
      "--no-playlist",
      "-f",
      "bestaudio/best",
      "-o",
      "-",
      target,
    ];

    if (config.ytDlpYoutubeArgs) {
      args.push("--extractor-args", config.ytDlpYoutubeArgs);
    }

    if (config.ytDlpPotProviderArgs) {
      args.push("--extractor-args", config.ytDlpPotProviderArgs);
    }

    if (config.ytDlpCookiesFile) {
      args.push("--cookies", config.ytDlpCookiesFile);
    }

    return args;
  }

  spawnAudioProcess(
    track,
    profile = "opus",
    inputMode = "url",
    sourceProcess = null,
    fadeIn = false,
  ) {
    const args = this.buildFfmpegArgsForInput(track, profile, inputMode);

    // Add fade-in for natural transitions (soft start)
    if (fadeIn) {
      const fadeFilter = `afade=t=in:ss=0:d=${CROSSFADE_FADE_IN_DURATION_SECONDS}`;
      const afIdx = args.indexOf("-af");
      if (afIdx >= 0) {
        args[afIdx + 1] += `,${fadeFilter}`;
      } else {
        args.push("-af", fadeFilter);
      }
    }
    const process = spawn(config.ffmpegPath, args, {
      stdio: [inputMode === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let probeReady = false;
    process.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    if (sourceProcess?.stdout && inputMode === "stdin") {
      sourceProcess.stdout.pipe(process.stdin);
      sourceProcess.stdout.on("error", () => null);
      process.stdin.on("error", () => null);
    }

    const startupFailure = new Promise((_, reject) => {
      process.once("error", (error) => {
        reject(new Error(`ffmpeg spawn failed: ${error.message}`));
      });
      process.once("close", (code) => {
        if (probeReady) {
          return;
        }
        reject(
          new Error(
            code && stderr.trim()
              ? `ffmpeg exited with code ${code}: ${truncate(stderr.trim(), 500)}`
              : "ffmpeg berhenti sebelum stream audio siap",
          ),
        );
      });
    });

    const probe = Promise.race([demuxProbe(process.stdout), startupFailure]);

    return {
      process,
      sourceProcess,
      probe,
      markProbeReady: () => {
        probeReady = true;
      },
      stderr: () => stderr,
    };
  }

  async createAudioPipeline(track, fadeIn = false) {
    if (!track.localPath && !track.streamUrl) {
      throw new Error(
        `Gagal mendapatkan direct stream audio untuk "${truncate(track.title, 50)}". Coba ulangi /play atau gunakan judul lagu.`,
      );
    }

    const primaryInputMode = track.localPath ? "local" : "url";
    let processState = this.spawnAudioProcess(track, "opus", primaryInputMode, null, fadeIn);
    let probed;

    try {
      probed = await processState.probe;
    } catch (error) {
      processState.process.kill("SIGKILL");
      processState.sourceProcess?.kill("SIGKILL");
      const message = String(error?.message || "");
      const canRetryWithPcm =
        /libopus|encoder|codec|output format|s16le|ogg/i.test(message) ||
        /Unknown encoder|Invalid argument|could not write header/i.test(
          message,
        );
      const canRetryViaYtDlpPipe =
        primaryInputMode === "url" &&
        /403|401|404|server returned|input\/output error|end of file|invalid data found|Connection reset|Forbidden|googlevideo/i.test(
          message,
        );

      if (canRetryViaYtDlpPipe) {
        const sourceProcess = spawn(
          config.ytDlpPath,
          this.buildYtDlpPipeArgs(track),
          {
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        processState = this.spawnAudioProcess(
          track,
          "opus",
          "stdin",
          sourceProcess,
          fadeIn,
        );
        try {
          probed = await processState.probe;
        } catch (pipeError) {
          processState.process.kill("SIGKILL");
          processState.sourceProcess?.kill("SIGKILL");
          const pipeMessage = String(pipeError?.message || "");
          const canRetryPipeWithPcm =
            /libopus|encoder|codec|output format|s16le|ogg/i.test(
              pipeMessage,
            ) ||
            /Unknown encoder|Invalid argument|could not write header/i.test(
              pipeMessage,
            );

          if (!canRetryPipeWithPcm) {
            console.log(`[PIPELINE:${this.guildId}] Cannot retry pipe with PCM, throwing`);
            throw pipeError;
          }

          console.log(`[PIPELINE:${this.guildId}] Retrying yt-dlp pipe with PCM fallback`);
          processState.sourceProcess?.kill("SIGKILL");
          const sourceProcessPcm = spawn(
            config.ytDlpPath,
            this.buildYtDlpPipeArgs(track),
            {
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          processState = this.spawnAudioProcess(
            track,
            "pcm",
            "stdin",
            sourceProcessPcm,
            fadeIn,
          );
          try {
            probed = await processState.probe;
            console.log(`[PIPELINE:${this.guildId}] yt-dlp pipe (PCM) probe succeeded`);
          } catch (pipeRetryError) {
            console.error(`[PIPELINE:${this.guildId}] yt-dlp pipe (PCM) also failed: ${pipeRetryError.message}`);
            processState.process.kill("SIGKILL");
            processState.sourceProcess?.kill("SIGKILL");
            throw pipeRetryError;
          }
        }
      } else {
        if (!canRetryWithPcm) {
          console.log(`[PIPELINE:${this.guildId}] Cannot retry, throwing original error`);
          throw error;
        }

        console.log(`[PIPELINE:${this.guildId}] Retrying with PCM (local/url input)`);
        processState = this.spawnAudioProcess(track, "pcm", primaryInputMode, null, fadeIn);
        try {
          probed = await processState.probe;
          console.log(`[PIPELINE:${this.guildId}] PCM retry probe succeeded`);
        } catch (retryError) {
          console.error(`[PIPELINE:${this.guildId}] PCM retry also failed: ${retryError.message}`);
          processState.process.kill("SIGKILL");
          processState.sourceProcess?.kill("SIGKILL");
          throw retryError;
        }
      }
    }
    processState.markProbeReady();
    console.log(`[PIPELINE:${this.guildId}] Pipeline created successfully | inputType=${probed.type} | pid=${processState.process.pid}`);
    const resource = createAudioResource(probed.stream, {
      inputType: probed.type,
      metadata: track,
    });

    const finalStderr = processState.stderr().trim();
    processState.process.once("close", (code) => {
      console.log(`[PIPELINE:${this.guildId}] ffmpeg process closed | pid=${processState.process.pid} | code=${code} | stderr=${finalStderr ? truncate(finalStderr, 200) : 'none'}`);
      if (this.currentProcess === processState.process) {
        this.currentProcess = null;
      }
      if (this.currentSourceProcess === processState.sourceProcess) {
        this.currentSourceProcess = null;
      }
      if (code && code !== 0 && finalStderr) {
        console.warn(
          `[player:${this.guildId}] ffmpeg exited with code ${code}: ${truncate(finalStderr, 500)}`,
        );
      }
    });

    return {
      resource,
      process: processState.process,
      sourceProcess: processState.sourceProcess,
    };
  }

  async publishNowPlaying(reason) {
    console.log(`[PUBLISH:${this.guildId}] publishNowPlaying | reason=${reason || 'update'} | current=${this.current ? truncate(this.current.title, 80) : 'null'} | hasMessage=${Boolean(this.currentMessage)}`);
    const runUpdate = async () => {
      if (!this.current || !this.lastTextChannelId) {
        console.log(`[PUBLISH:${this.guildId}] Skipping: current=${Boolean(this.current)} channelId=${Boolean(this.lastTextChannelId)}`);
        return;
      }
      const channel = await this.client.channels
        .fetch(this.lastTextChannelId)
        .catch(() => null);
      if (!channel?.isTextBased()) return;

      const embed = this.buildNowPlayingEmbed();
      const components = this.buildControlRows();

      if (this.currentMessage) {
        try {
          this.currentMessage = await this.currentMessage.edit({
            embeds: [embed],
            components,
          });
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
      .setAuthor({ name: "Now Playing" })
      .setTitle(truncate(this.current.title, 256) || "Unknown")
      .setDescription(
        [
          `👤 **Uploader:** ${truncate(this.current.uploader || "Unknown", 50)}`,
          `⏱️ **Duration:** \`${formatDuration(this.current.duration)}\``,
          `💾 **Source:** \`${this.current.localPath ? "local-cache" : "stream"}\``,
          `📦 **Cache:** ${this.getTrackCacheStatusLabel(this.current)}`,
          "",
          `YouTube: ${this.getYoutubeStatusLabel()}`,
          `**Settings:** Loop \`${status.loopMode}\` | Autoplay \`${status.autoplay ? "On" : "Off"}\` | Queue \`${this.queue.length}\``,
        ].join("\n"),
      )
      .setFooter({
        text: `Requested by ${this.current.requester?.name || "Unknown"}`,
      });

    if (this.current.webpageUrl) embed.setURL(this.current.webpageUrl);
    if (this.current.thumbnail) embed.setThumbnail(this.current.thumbnail);

    return embed;
  }

  buildControlRows() {
    const isPaused = this.player.state.status === AudioPlayerStatus.Paused;

    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("player:toggle")
          .setLabel(isPaused ? "▶️ Resume" : "⏸️ Pause")
          .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("player:skip")
          .setLabel("⏭️ Skip")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("player:stop")
          .setLabel("⏹️ Stop")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("player:shuffle")
          .setLabel("🔀 Shuffle")
          .setStyle(
            this.shuffleActive ? ButtonStyle.Success : ButtonStyle.Secondary,
          ),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("player:autoplay")
          .setLabel("✨ Autoplay")
          .setStyle(
            this.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary,
          ),
        new ButtonBuilder()
          .setCustomId("player:loop")
          .setLabel(`🔁 Loop ${this.loopMode !== "off" ? this.loopMode : ""}`)
          .setStyle(
            this.loopMode !== "off"
              ? ButtonStyle.Success
              : ButtonStyle.Secondary,
          ),
        new ButtonBuilder()
          .setCustomId("player:queue")
          .setLabel("📋 Queue")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("player:lyrics")
          .setLabel("🎤 Lyrics")
          .setStyle(ButtonStyle.Secondary),
      ),
    ];
  }

  async sendStatusMessage(content) {
    if (!this.lastTextChannelId) return;
    const channel = await this.client.channels
      .fetch(this.lastTextChannelId)
      .catch(() => null);
    if (channel?.isTextBased()) {
      await channel
        .send({ content: truncate(content, 1900) })
        .catch(() => null);
    }
  }

  async notifyNetworkRestored() {
    if (!this.lastTextChannelId || (!this.current && this.queue.length === 0)) {
      return;
    }

    await this.sendStatusMessage(
      "⚠️ **Koneksi internet terganggu.** Barusan terjadi gangguan jaringan (*network outage*) yang menyebabkan playback/pencarian terganggu. Sekarang koneksi sudah kembali normal.",
    );

    // Jika player idle tetapi ada antrean, coba lanjut
    if (
      this.player.state.status === AudioPlayerStatus.Idle &&
      this.queue.length > 0 &&
      !this.stopRequested
    ) {
      void this.queuePlayNext("network-recovery");
    }
  }

  async skip() {
    console.log(`[SKIP:${this.guildId}] skip() called | current=${this.current ? truncate(this.current.title, 80) : 'null'} | queue=${this.queue.length} | skipTransitionActive=${this.skipTransitionActive} | skipRequested=${this.skipRequested} | playerStatus=${this.player.state.status} | playNextPromise=${Boolean(this.playNextPromise)}`);

    if (!this.current && !this.playNextPromise) {
      console.log(`[SKIP:${this.guildId}] No current track and no playNextPromise, throwing error`);
      throw new Error("Tidak ada lagu yang sedang diputar");
    }

    if (this.skipTransitionActive) {
      console.log(`[SKIP:${this.guildId}] skipTransitionActive already true, returning false (skip in progress)`);
      return false;
    }

    this.consecutiveErrors = 0; // Reset counter jika skip manual
    this.skipRequested = true;
    this.skipTransitionActive = true;
    this.playNonce += 1;
    console.log(`[SKIP:${this.guildId}] State set | skipRequested=true | skipTransitionActive=true | playNonce=${this.playNonce}`);

    if (this.player.state.status === AudioPlayerStatus.Idle) {
      console.log(`[SKIP:${this.guildId}] Player is idle, handling skip manually`);
      if (this.current) {
        const finished = this.current;
        finished.seekSeconds = 0;
        this.history.push(finished);
        if (this.history.length > 25) {
          this.history = this.history.slice(-25);
        }
        console.log(`[SKIP:${this.guildId}] Pushed idle current to history | history=${this.history.length}`);
      }
      this.current = null;
      this.skipRequested = false;
      console.log(`[SKIP:${this.guildId}] Calling queuePlayNext("skip")`);
      void this.queuePlayNext("skip");
      return true;
    }

    // Crossfade skip: prepare combined pipeline with current + next track
    const nonce = this.playNonce;
    const currentTrack = this.current;
    const nextTrack = this.queue[0];

    console.log(`[SKIP:${this.guildId}] Attempting crossfade skip | nonce=${nonce} | currentTrack=${currentTrack ? truncate(currentTrack.title, 80) : 'null'} | nextTrack=${nextTrack ? truncate(nextTrack.title, 80) : 'null'} | nextTrackHasStream=${Boolean(nextTrack?.streamUrl || nextTrack?.localPath)}`);

    if (!currentTrack || !nextTrack || (!currentTrack.streamUrl && !currentTrack.localPath)) {
      console.log(`[SKIP:${this.guildId}] Crossfade not possible, falling back to hard stop: missing current=${Boolean(currentTrack)} missing next=${Boolean(nextTrack)} hasStream=${Boolean(nextTrack?.streamUrl || nextTrack?.localPath)}`);
      // Fallback: skip without crossfade
      this.skipTransitionActive = false;
      console.log(`[SKIP:${this.guildId}] Calling player.stop(true) for hard skip`);
      this.player.stop(true);
      return true;
    }

    const currentPosition = this.getElapsedSeconds();
    const remainingSeconds = currentTrack.duration
      ? (currentTrack.duration || 0) - currentPosition
      : CROSSFADE_DURATION_SECONDS + 1; // durasi tidak diketahui, asumsikan cukup

    console.log(`[SKIP:${this.guildId}] Crossfade check | currentPosition=${currentPosition}s | remainingSeconds=${remainingSeconds}s | trackDuration=${currentTrack.duration}s`);

    // Crossfade hanya jika remaining time cukup
    if (remainingSeconds < 1) {
      console.log(`[SKIP:${this.guildId}] Remaining time < 1s, falling back to hard stop`);
      this.skipTransitionActive = false;
      this.player.stop(true);
      return true;
    }

    try {
      // Prepare next track for crossfade
      console.log(`[SKIP:${this.guildId}] Preparing next track for crossfade...`);
      const hydrateStartedAt = Date.now();
      await withTimeout(
        this.prepareTrackForPlayback(nextTrack, {
          trigger: "skip-crossfade",
          allowBackgroundDownload: false,
        }),
        TRACK_PREPARE_TIMEOUT_MS,
        "persiapan track skip crossfade",
      );
      console.log(`[SKIP:${this.guildId}] Next track prepared for crossfade | hydrateMs=${Date.now() - hydrateStartedAt}ms`);

      if (nonce !== this.playNonce) {
        console.log(`[SKIP:${this.guildId}] Nonce changed after hydration, aborting`);
        return true;
      }

      const args = this.buildCrossfadeFfmpegArgs(currentTrack, nextTrack, currentPosition);
      console.log(`[SKIP:${this.guildId}] Spawning crossfade ffmpeg process...`);
      const process = spawn(config.ffmpegPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      let probeReady = false;
      process.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      const startupFailure = new Promise((_, reject) => {
        process.once("error", (error) => {
          reject(new Error(`ffmpeg crossfade spawn failed: ${error.message}`));
        });
        process.once("close", (code) => {
          if (probeReady) return;
          reject(
            new Error(
              code && stderr.trim()
                ? `ffmpeg crossfade exited with code ${code}: ${truncate(stderr.trim(), 500)}`
                : "ffmpeg crossfade berhenti sebelum stream audio siap",
            ),
          );
        });
      });

      console.log(`[SKIP:${this.guildId}] Probing crossfade stream...`);
      const probed = await Promise.race([
        demuxProbe(process.stdout),
        startupFailure,
      ]);

      if (nonce !== this.playNonce) {
        console.log(`[SKIP:${this.guildId}] Nonce changed after probe, killing process`);
        process.kill("SIGKILL");
        return true;
      }

      probeReady = true;
      console.log(`[SKIP:${this.guildId}] Crossfade stream probed successfully | inputType=${probed.type}`);

      const resource = createAudioResource(probed.stream, {
        inputType: probed.type,
        metadata: nextTrack,
      });

      // Kill old processes
      if (this.currentProcess) {
        console.log(`[SKIP:${this.guildId}] Killing old currentProcess`);
        this.currentProcess.kill("SIGKILL");
      }
      if (this.currentSourceProcess) {
        console.log(`[SKIP:${this.guildId}] Killing old currentSourceProcess`);
        this.currentSourceProcess.kill("SIGKILL");
      }

      this.clearLyricMessages();
      this.currentProcess = process;
      this.currentSourceProcess = null;

      process.once("close", () => {
        console.log(`[SKIP:${this.guildId}] Crossfade ffmpeg closed`);
        this.schedulePipelineCompletionAdvance(nextTrack, nonce, "crossfade-close");
      });

      // Remove next track from queue (it's now being played in the crossfade)
      this.queue.shift();

      // Move current track to history
      currentTrack.seekSeconds = 0;
      this.history.push(currentTrack);
      if (this.history.length > 25) {
        this.history = this.history.slice(-25);
      }

      console.log(`[SKIP:${this.guildId}] Crossfade state | queueAfterShift=${this.queue.length} | history=${this.history.length}`);

      this.current = nextTrack;
      this.currentMetrics = {
        requestStartedAt: nextTrack.requestStartedAt || nextTrack.addedAt || Date.now(),
        playNextStartedAt: Date.now(),
        hydrateMs: Date.now() - hydrateStartedAt,
        pipelineMs: 0,
        logged: false,
      };

      console.log(`[SKIP:${this.guildId}] Playing crossfade resource for "${truncate(nextTrack.title, 80)}"`);
      this.player.play(resource);
      void this.publishNowPlaying("skip-crossfade");
      void this.preloadUpcomingTracks();
      if (this.autoplay && this.queue.length === 0) {
        console.log(`[SKIP:${this.guildId}] Queue empty after crossfade, preparing autoplay`);
        void this.prepareAutoplayTrack();
      }
    } catch (error) {
      console.warn(
        `[SKIP:${this.guildId}] crossfade skip failed, falling back: ${error.message}`,
      );
      // Fallback: regular skip
      this.playNonce = nonce;
      this.current = currentTrack;
      this.queue.unshift(nextTrack);
      this.skipTransitionActive = false;
      console.log(`[SKIP:${this.guildId}] Fallback: calling player.stop(true)`);
      this.player.stop(true);
    }

    return true;
  }

  async stop({ disconnect = false } = {}) {
    console.log(`[STOP:${this.guildId}] stop() called | disconnect=${disconnect} | current=${this.current ? truncate(this.current.title, 80) : 'null'} | queue=${this.queue.length} | autoplay=${this.autoplay} | stopRequested=${this.stopRequested}`);

    this.clearPipelineCompletionTimer();
    clearTimeout(this.crossfadeBufferTimer);
    this.crossfadeBufferTimer = null;
    this.queue = [];
    this.current = null;
    this.finishedTrack = null;
    this.currentMetrics = null;
    this.playbackStartedAt = null;
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
      console.log(`[STOP:${this.guildId}] Killing currentProcess`);
      this.currentProcess.kill("SIGKILL");
      this.currentProcess = null;
    }
    if (this.currentSourceProcess) {
      console.log(`[STOP:${this.guildId}] Killing currentSourceProcess`);
      this.currentSourceProcess.kill("SIGKILL");
      this.currentSourceProcess = null;
    }

    this.clearLyricMessages();
    if (this.currentMessage) {
      await this.currentMessage.delete().catch(() => null);
      this.currentMessage = null;
    }

    if (disconnect) {
      const connection = getVoiceConnection(this.guildId);
      console.log(`[STOP:${this.guildId}] Destroying voice connection`);
      connection?.destroy();
    }

    console.log(`[STOP:${this.guildId}] Stop complete`);
  }

  togglePause() {
    if (!this.current) throw new Error("Tidak ada lagu yang sedang diputar");
    if (this.player.state.status === AudioPlayerStatus.Paused) {
      this.player.unpause();
      void this.publishNowPlaying("update");
      return false;
    }
    this.player.pause();
    void this.publishNowPlaying("update");
    return true;
  }

  async seek(seconds) {
    console.log(`[SEEK:${this.guildId}] seek(${seconds}) | current=${this.current ? truncate(this.current.title, 80) : 'null'}`);
    if (!this.current) throw new Error("Tidak ada lagu yang sedang diputar");
    this.current.seekSeconds = Math.max(0, seconds);
    console.log(`[SEEK:${this.guildId}] Setting seekSeconds=${this.current.seekSeconds}, unshifting to queue, stopping player`);
    this.queue.unshift(this.current);
    this.current = null;
    this.playNonce += 1;
    this.player.stop(true);
    console.log(`[SEEK:${this.guildId}] seek done | queue=${this.queue.length}`);
  }

  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    this.shuffleActive = this.queue.length > 1;
    void this.preloadUpcomingTracks();
    void this.publishNowPlaying("queue-update");
    return this.queue.length;
  }

  move(from, to) {
    this.shuffleActive = false;
    if (
      from < 1 ||
      from > this.queue.length ||
      to < 1 ||
      to > this.queue.length
    ) {
      throw new Error("Posisi queue tidak valid");
    }

    const [track] = this.queue.splice(from - 1, 1);
    this.queue.splice(to - 1, 0, track);
    void this.preloadUpcomingTracks();
    void this.publishNowPlaying("queue-update");
  }

  setLoopMode(mode) {
    this.loopMode = mode;
    void this.publishNowPlaying("update");
  }

  nextLoopMode() {
    this.loopMode =
      this.loopMode === "off"
        ? "track"
        : this.loopMode === "track"
          ? "queue"
          : "off";
    void this.publishNowPlaying("update");
    return this.loopMode;
  }

  toggleAutoplay() {
    this.autoplay = !this.autoplay;
    console.log(`[AUTOPLAY_TOGGLE:${this.guildId}] Autoplay toggled to ${this.autoplay} | queue=${this.queue.length} | autoplayPreparePromise=${Boolean(this.autoplayPreparePromise)} | current=${this.current ? truncate(this.current.title, 80) : 'null'}`);

    if (
      this.autoplay &&
      this.queue.length === 0 &&
      !this.autoplayPreparePromise
    ) {
      console.log(`[AUTOPLAY_TOGGLE:${this.guildId}] Queue empty, triggering prepareAutoplayTrack`);
      void this.prepareAutoplayTrack();
    } else {
      console.log(`[AUTOPLAY_TOGGLE:${this.guildId}] Skipping autoplay prep: queueNotEmpty=${this.queue.length > 0} hasPromise=${Boolean(this.autoplayPreparePromise)}`);
    }
    void this.publishNowPlaying("update");
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
    if (!voiceChannel)
      throw new Error("Kamu harus berada di voice channel terlebih dahulu");
    const connection = getVoiceConnection(this.guildId);
    connection?.destroy();
    await this.ensureVoice(voiceChannel);
  }

  async lyricsForCurrent() {
    if (!this.current) throw new Error("Tidak ada lagu yang sedang diputar");
    return this.lyrics.search(this.current.title, this.current.uploader);
  }

  queueLines(limit = 10) {
    const lines = [];
    if (this.current) {
      lines.push(`Sedang diputar: **${this.current.title}**`);
    }
    if (this.queue.length === 0) {
      lines.push("Queue kosong.");
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
