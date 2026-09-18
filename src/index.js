import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  MessageFlags,
  REST,
  Routes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { config, validateConfig } from './config.js';
import { commands } from './discord/commands.js';
import { AudioCacheService } from './services/audioCache.js';
import { LyricsService } from './services/lyrics.js';
import { YTDlpService } from './services/ytdlp.js';
import { PlaylistService } from './services/playlistService.js';
import { PlayerManager } from './player/PlayerManager.js';
import { formatBytes, formatDuration, isTransientNetworkError, truncate } from './utils/format.js';

validateConfig();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const ytdlp = new YTDlpService();
const audioCache = new AudioCacheService();
const playlists = new PlaylistService();
const lyrics = new LyricsService();
const players = new PlayerManager({ client, ytdlp, lyrics, audioCache });
const AUTO_DELETE_MS = 5000;
const CACHE_LIST_PAGE_SIZE = 10;
const CACHE_LIST_SESSION_TTL_MS = 15 * 60 * 1000;
const LOGIN_RETRY_BASE_DELAY_MS = 5_000;
const LOGIN_RETRY_MAX_DELAY_MS = 60_000;
let networkOutageDetected = false;
const cacheListSessions = new Map();

function helpEmbed() {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle('Omnia Music Help')
    .setDescription(
      [
        '`/play <query>` putar lagu atau playlist',
        '`/offlinemode <query>` putar semua cache yang cocok tanpa YouTube',
        '`/normalmode` paksa kembali ke mode normal',
        '`/skip` lewati lagu sekarang',
        '`/stop` stop dan disconnect',
        '`/seek <seconds>` lompat ke posisi tertentu',
        '`/queue` lihat queue aktif',
        '`/loop <off|track|queue>` atur loop mode',
        '`/shuffle` acak queue',
        '`/autoplay` toggle autoplay',
        '`/move <from> <to>` pindah antrean',
        '`/status` lihat status player',
        '`/lyrics` ambil lirik saat ini',
        '`/cache-stats` statistik cache lokal',
        '`/cache-list [query]` daftar lagu cache',
        '`/cache-delete <query>` hapus lagu dari cache',
        '`/sleep <minutes>` auto stop',
        '`/reconnect` sambung ulang voice',
        '`/playlist <subcommand>` kelola & putar playlist pribadi (maks 10 playlist, 50 lagu)'
      ].join('\n')
    );
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  const route = config.devGuildId
    ? Routes.applicationGuildCommands(config.clientId, config.devGuildId)
    : Routes.applicationCommands(config.clientId);

  await rest.put(route, { body: commands });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}



async function loginWithRetry() {
  let attempt = 0;

  while (true) {
    try {
      await client.login(config.discordToken);
      return;
    } catch (error) {
      attempt += 1;
      const delayMs = Math.min(LOGIN_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), LOGIN_RETRY_MAX_DELAY_MS);
      console.error(`[discord] login failed (attempt ${attempt})`, error);
      await delay(delayMs);
    }
  }
}

function registerRuntimeHandlers() {
  process.on('unhandledRejection', (reason) => {
    console.error('[process] unhandled rejection', reason);
  });

  process.on('uncaughtException', (error) => {
    const transient = isTransientNetworkError(error);
    if (transient) networkOutageDetected = true;
    console.error(`[process] uncaught exception${transient ? ' (transient-network)' : ''}`, error);
  });

  client.on('error', (error) => {
    if (isTransientNetworkError(error)) networkOutageDetected = true;
    console.error('[discord] client error', error);
  });

  client.on('warn', (message) => {
    console.warn('[discord] warn', message);
  });

  client.on('shardDisconnect', (event, shardId) => {
    console.warn(`[discord] shard ${shardId} disconnected`, {
      code: event.code,
      reason: event.reason
    });
  });

  client.on('shardError', (error, shardId) => {
    console.error(`[discord] shard ${shardId} error`, error);
  });

  client.on('shardReconnecting', (shardId) => {
    console.warn(`[discord] shard ${shardId} reconnecting`);
  });

  client.on('shardResume', (shardId, replayedEvents) => {
    console.log(`[discord] shard ${shardId} resumed (${replayedEvents} replayed events)`);
    void broadcastNetworkRecovery();
  });

  client.on('invalidated', () => {
    console.error('[discord] session invalidated');
  });
}

function playerFor(interaction) {
  return players.get(interaction.guildId);
}

async function resolveMember(interaction) {
  if (interaction.member?.voice) {
    return interaction.member;
  }

  return interaction.guild.members.fetch(interaction.user.id);
}

function formatDiscordTimestamp(timestamp, style = 'R') {
  return timestamp ? `<t:${Math.floor(timestamp / 1000)}:${style}>` : 'Belum pernah';
}

function youtubeErrorKindLabel(kind) {
  switch (kind) {
    case 'service_unavailable':
      return 'Akses layanan / cookies / PO token';
    case 'track_unavailable':
      return 'Pembatasan lagu';
    case 'unknown':
      return 'Tidak diketahui';
    default:
      return 'Tidak ada';
  }
}

async function statusEmbed(player) {
  const status = player.status();
  const cacheStats = await player.audioCache.getStats().catch(() => null);
  const lines = [
    `Connected: \`${status.connected}\``,
    `Paused: \`${status.paused}\``,
    `Loop: \`${status.loopMode}\``,
    `Autoplay: \`${status.autoplay}\``,
    `Queue size: \`${status.queueSize}\``,
    `Playback mode: \`${status.offlineMode ? 'offline-cache-only' : 'normal'}\``,
    `YouTube: \`${status.youtubeStatus}\``,
    `Kategori error terakhir: \`${youtubeErrorKindLabel(status.youtubeLastFailureKind)}\``,
    `Probe terakhir: ${formatDiscordTimestamp(status.youtubeLastCheckedAt)}`,
  ];

  if (status.youtubeLastFailureAt) {
    lines.push(`Error terakhir: ${formatDiscordTimestamp(status.youtubeLastFailureAt)}`);
  }

  if (status.offlineMode) {
    lines.push(`Filter offline: \`${truncate(status.offlineModeQuery, 80)}\``);
    lines.push(`Sesi offline dimulai: ${formatDiscordTimestamp(status.offlineModeStartedAt)}`);
  }

  if (status.youtubeStatus === 'down') {
    lines.push(`Probe pemulihan berikutnya: ${formatDiscordTimestamp(status.youtubeNextProbeAt)}`);
  }

  if (status.youtubeLastFailureReason) {
    lines.push(`Alasan error terakhir: ${truncate(status.youtubeLastFailureReason, 120)}`);
  }

  if (cacheStats) {
    lines.push(
      `Cache: \`${cacheStats.totalTracks}/${cacheStats.maxTracks} lagu\` | \`${formatBytes(cacheStats.totalBytes)}/${formatBytes(cacheStats.maxBytes)}\``
    );
  } else {
    lines.push('Cache: `statistik tidak tersedia`');
  }

  if (status.current) {
    lines.push(`Current: **${status.current.title}**`);
  }

  if (status.sleepUntil) {
    lines.push(`Sleep until: <t:${Math.floor(status.sleepUntil / 1000)}:R>`);
  }

  const color = status.youtubeStatus === 'down' ? 0xe67e22 : status.youtubeStatus === 'up' ? 0x2ecc71 : 0x95a5a6;
  return new EmbedBuilder().setColor(color).setTitle('Player Status').setDescription(lines.join('\n'));
}

function scheduleInteractionDelete(interaction, delayMs = AUTO_DELETE_MS) {
  setTimeout(() => {
    interaction.deleteReply().catch(() => null);
  }, delayMs);
}

function cleanupExpiredCacheListSessions() {
  const now = Date.now();
  for (const [sessionId, session] of cacheListSessions.entries()) {
    if (now - session.updatedAt > CACHE_LIST_SESSION_TTL_MS) {
      cacheListSessions.delete(sessionId);
    }
  }
}

function createCacheListSession(userId, query = '') {
  cleanupExpiredCacheListSessions();
  const sessionId = randomUUID();
  cacheListSessions.set(sessionId, {
    userId,
    query,
    page: 0,
    updatedAt: Date.now()
  });
  return sessionId;
}

function getCacheListSession(sessionId) {
  cleanupExpiredCacheListSessions();
  const session = cacheListSessions.get(sessionId);
  if (!session) {
    return null;
  }

  session.updatedAt = Date.now();
  return session;
}

async function buildCacheListView(player, { query = '', page = 0 } = {}) {
  const safePage = Math.max(0, page);
  const offset = safePage * CACHE_LIST_PAGE_SIZE;
  const result = await player.audioCache.listEntries({
    query,
    limit: CACHE_LIST_PAGE_SIZE,
    offset
  });

  const totalPages = Math.max(1, Math.ceil(result.total / CACHE_LIST_PAGE_SIZE));
  const currentPage = Math.min(safePage, totalPages - 1);
  const currentOffset = currentPage * CACHE_LIST_PAGE_SIZE;
  const currentResult = currentPage === safePage
    ? result
    : await player.audioCache.listEntries({
      query,
      limit: CACHE_LIST_PAGE_SIZE,
      offset: currentOffset
    });

  const startNumber = currentOffset + 1;
  const lines = currentResult.entries.map((entry, index) =>
    `${startNumber + index}. ${truncate(entry.track?.title || entry.canonicalKey, 80)} | ${formatDuration(entry.track?.duration || 0)} | ${formatBytes(entry.sizeBytes)}`
  );

  const embed = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle(query ? `Cache List: ${truncate(query, 80)}` : 'Cache List')
    .setDescription(
      lines.length > 0
        ? `${lines.join('\n')}\n\nMenampilkan ${currentResult.entries.length} lagu. Total hasil: ${currentResult.total}.`
        : 'Cache kosong atau tidak ada hasil untuk filter tersebut.'
    )
    .setFooter({ text: `Halaman ${currentPage + 1}/${totalPages} • Query: ${query || 'semua lagu'}` });

  return {
    embed,
    page: currentPage,
    total: currentResult.total,
    totalPages
  };
}

function buildCacheListComponents(sessionId, { page = 0, totalPages = 1 } = {}) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`cache:list:${sessionId}:prev`)
        .setLabel('Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`cache:list:${sessionId}:next`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1),
      new ButtonBuilder()
        .setCustomId(`cache:list:${sessionId}:search`)
        .setLabel('Search')
        .setStyle(ButtonStyle.Primary)
    )
  ];
}

client.once('clientReady', async () => {
  try {
    await registerCommands();
  } catch (error) {
    console.error('[discord] command registration failed', error);
  }

  console.log(`Omnia Music is online as ${client.user.tag}`);
  void broadcastNetworkRecovery();
});

client.on('voiceStateUpdate', (oldState, newState) => {
  const guildId = newState.guild?.id || oldState.guild?.id;
  if (!guildId) {
    return;
  }

  const player = players.getIfExists(guildId);
  if (!player?.voiceChannelId) {
    return;
  }

  const impactedChannelIds = new Set([oldState.channelId, newState.channelId]);
  if (!impactedChannelIds.has(player.voiceChannelId)) {
    return;
  }

  void player.refreshEmptyChannelTimeout();
});

async function broadcastNetworkRecovery() {
  if (!networkOutageDetected) return;
  networkOutageDetected = false;
  console.log('[network] Recovery detected. Notifying active players...');

  const activePlayers = [...players.players.values()];
  for (const player of activePlayers) {
    player.notifyNetworkRestored().catch((err) => {
      console.error(`[network] Failed to notify guild ${player.guildId}:`, err.message);
    });
  }
}

function buildPlaylistSelectRow(userPlaylists, customId, placeholder = 'Pilih playlist...') {
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(
      userPlaylists.slice(0, 25).map((pl) => ({
        label: truncate(pl.name, 50),
        description: `${pl.trackCount}/${config.maxUserPlaylistTracks} lagu (${formatDuration(pl.totalDuration)})`,
        value: pl.name
      }))
    );
  return new ActionRowBuilder().addComponents(select);
}

function renderPlaylistViewEmbed(data) {
  const trackLines = data.tracks.map((t) => `${t.position}. [${truncate(t.title, 55)}](${t.url}) - \`${formatDuration(t.duration)}\``).join('\n');
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`Playlist: ${data.playlist.name}`)
    .setDescription(trackLines)
    .setFooter({
      text: `Halaman ${data.currentPage}/${data.totalPages} • Total: ${data.totalTracks}/${config.maxUserPlaylistTracks} lagu (${formatDuration(data.totalDuration)})`
    });
}

client.on('interactionCreate', async (interaction) => {
  if (interaction.isAutocomplete()) {
    try {
      if (interaction.commandName === 'playlist') {
        const focused = interaction.options.getFocused(true);
        if (focused.name === 'name') {
          const userPlaylists = playlists.getPlaylists(interaction.guildId, interaction.user.id);
          const filterVal = String(focused.value || '').toLowerCase();
          const filtered = userPlaylists
            .filter((p) => p.name.toLowerCase().includes(filterVal))
            .slice(0, 25)
            .map((p) => ({
              name: `${truncate(p.name, 50)} (${p.trackCount}/${config.maxUserPlaylistTracks} lagu)`,
              value: p.name
            }));
          await interaction.respond(filtered).catch(() => null);
        }
      }
    } catch {
      // Autocomplete failures must not crash the bot
    }
    return;
  }

  if (interaction.isChatInputCommand()) {
    const player = playerFor(interaction);

    try {
      switch (interaction.commandName) {
        case 'play': {
          await interaction.deferReply();
          const query = interaction.options.getString('query', true);
          await interaction.editReply({ content: `🔍 Sedang mencari **${truncate(query, 50)}**...` });

          const member = await resolveMember(interaction);
          const result = await player.enqueue({
            member,
            textChannel: interaction.channel,
            query
          });

          if (result.failover) {
            await interaction.editReply({
              content: `YouTube sedang error. Memutar lagu dari cache lokal: **${truncate(result.tracks[0].title, 120)}**.`
            });
          } else if (result.fromCache) {
            await interaction.editReply({
              content: `Memutar dari cache lokal: **${truncate(result.tracks[0].title, 120)}**.`
            });
          } else if (result.type === 'playlist') {
            await interaction.editReply({
              content: `Playlist **${truncate(result.playlistTitle, 120)}** dimasukkan ke queue: ${result.tracks.length} lagu pertama.`
            });
          } else {
            await interaction.editReply({ content: `Menambahkan **${truncate(result.tracks[0].title, 120)}** ke queue.` });
          }
          
          setTimeout(() => {
            interaction.deleteReply().catch(() => null);
          }, 5000);
          break;
        }
        case 'offlinemode': {
          await interaction.deferReply();
          const query = interaction.options.getString('query', true);
          const result = await player.enableOfflineMode({
            member: await resolveMember(interaction),
            textChannel: interaction.channel,
            query
          });
          await interaction.editReply({
            content: `Mode offline aktif. Memuat ${result.tracks.length} lagu cache untuk **${truncate(query, 100)}**.`
          });
          setTimeout(() => interaction.deleteReply().catch(() => null), AUTO_DELETE_MS);
          break;
        }
        case 'normalmode': {
          const changed = player.setNormalMode('force-normal-command');
          await interaction.reply({
            content: changed
              ? 'Mode normal aktif kembali. Lagu lokal yang sedang berjalan tetap dilanjutkan.'
              : 'Player sudah berada di mode normal.',
            flags: MessageFlags.Ephemeral
          });
          scheduleInteractionDelete(interaction);
          break;
        }
        case 'skip': {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const skipped = await player.skip();
          await interaction.editReply({
            content: skipped ? 'Lagu dilewati.' : 'Skip sebelumnya masih diproses.'
          });
          scheduleInteractionDelete(interaction);
          break;
        }
        case 'stop':
          await player.stop({ disconnect: true });
          await interaction.reply({ content: 'Playback dihentikan.', flags: MessageFlags.Ephemeral });
          scheduleInteractionDelete(interaction);
          break;
        case 'seek':
          await player.seek(interaction.options.getInteger('seconds', true));
          await interaction.reply({ content: 'Playback dipindahkan.', flags: MessageFlags.Ephemeral });
          scheduleInteractionDelete(interaction);
          break;
        case 'queue':
          await interaction.reply({
            embeds: [new EmbedBuilder().setColor(0x00c2ff).setTitle('Queue').setDescription(player.queueLines().join('\n'))],
            flags: MessageFlags.Ephemeral
          });
          break;
        case 'loop':
          player.setLoopMode(interaction.options.getString('mode', true));
          await interaction.reply({ content: `Loop mode diubah ke \`${player.loopMode}\`.`, flags: MessageFlags.Ephemeral });
          scheduleInteractionDelete(interaction);
          break;
        case 'shuffle':
          await interaction.reply({ content: `Queue diacak. Total: ${player.shuffle()}.`, flags: MessageFlags.Ephemeral });
          scheduleInteractionDelete(interaction);
          break;
        case 'autoplay':
          await interaction.reply({ content: `Autoplay \`${player.toggleAutoplay()}\`.`, flags: MessageFlags.Ephemeral });
          scheduleInteractionDelete(interaction);
          break;
        case 'help':
          await interaction.reply({ embeds: [helpEmbed()], flags: MessageFlags.Ephemeral });
          break;
        case 'move':
          player.move(interaction.options.getInteger('from', true), interaction.options.getInteger('to', true));
          await interaction.reply({ content: 'Queue diperbarui.', flags: MessageFlags.Ephemeral });
          scheduleInteractionDelete(interaction);
          break;
        case 'status':
          await interaction.reply({ embeds: [await statusEmbed(player)], flags: MessageFlags.Ephemeral });
          break;
        case 'lyrics': {
          await interaction.deferReply();
          const lyric = await player.lyricsForCurrent().catch(() => null);
          if (!lyric) {
            return await interaction.editReply({ content: '❌ Lirik tidak ditemukan untuk lagu ini.' });
          }
          const rawLyrics = lyric.syncedLyrics || lyric.plainLyrics || 'Lyrics kosong.';
          const cleanLyrics = rawLyrics.replace(/^\[\d{2}:\d{2}\.\d{2,}\]\s?/gm, '');
          const text = truncate(cleanLyrics, 3800);
          const msg = await interaction.editReply({
            embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle(`Lyrics: ${lyric.artistName} - ${lyric.trackName}`).setDescription(text)]
          });
          player.addLyricMessage(msg);
          break;
        }
        case 'cache-stats': {
          const stats = await player.audioCache.getStats();
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle('Cache Stats')
                .setDescription([
                  `Jumlah lagu: \`${stats.totalTracks}\` / \`${stats.maxTracks}\``,
                  `Total size: \`${formatBytes(stats.totalBytes)}\` / \`${formatBytes(stats.maxBytes)}\``
                ].join('\n'))
            ],
            flags: MessageFlags.Ephemeral
          });
          break;
        }
        case 'cache-list': {
          const query = interaction.options.getString('query') || '';
          const sessionId = createCacheListSession(interaction.user.id, query);
          const view = await buildCacheListView(player, { query, page: 0 });

          await interaction.reply({
            embeds: [view.embed],
            components: buildCacheListComponents(sessionId, view),
            flags: MessageFlags.Ephemeral
          });
          break;
        }
        case 'cache-delete': {
          const query = interaction.options.getString('query', true);
          const removed = await player.audioCache.deleteByQuery(query);
          if (!removed) {
            await interaction.reply({ content: `Cache tidak menemukan lagu untuk "${truncate(query, 80)}".`, flags: MessageFlags.Ephemeral });
            break;
          }

          await interaction.reply({
            content: `Cache menghapus **${truncate(removed.track?.title || removed.canonicalKey, 120)}** (${formatBytes(removed.sizeBytes)}).`,
            flags: MessageFlags.Ephemeral
          });
          break;
        }
        case 'sleep': {
          const until = player.setSleep(interaction.options.getInteger('minutes', true));
          await interaction.reply({
            content: `Sleep timer aktif sampai <t:${Math.floor(until / 1000)}:R>.`,
            flags: MessageFlags.Ephemeral
          });
          break;
        }
        case 'reconnect':
          await player.reconnect(await resolveMember(interaction));
          await interaction.reply({ content: 'Voice connection disambungkan ulang.', flags: MessageFlags.Ephemeral });
          scheduleInteractionDelete(interaction);
          break;
        case 'playlist': {
          const sub = interaction.options.getSubcommand();
          switch (sub) {
            case 'create': {
              const name = interaction.options.getString('name', true);
              const pl = playlists.createPlaylist(interaction.guildId, interaction.user.id, name);
              await interaction.reply({
                content: `✅ Playlist **${pl.name}** berhasil dibuat. Gunakan \`/playlist add\` untuk menambah lagu.`,
                flags: MessageFlags.Ephemeral
              });
              break;
            }
            case 'import': {
              const name = interaction.options.getString('name', true);
              const url = interaction.options.getString('url', true);
              await interaction.deferReply({ flags: MessageFlags.Ephemeral });
              const resolved = await ytdlp.resolve(url);
              if (!resolved.tracks || resolved.tracks.length === 0) {
                await interaction.editReply({ content: '❌ URL YouTube tidak valid atau playlist tidak memiliki lagu.' });
                break;
              }
              const result = playlists.importPlaylist(interaction.guildId, interaction.user.id, name, resolved.tracks);
              let msg = `✅ Berhasil mengimpor **${result.importedCount} lagu** ke playlist **${result.name}**.`;
              if (result.totalProvided > result.importedCount) {
                msg += ` *(Dibatasi hingga ${config.maxUserPlaylistTracks} lagu pertama dari ${result.totalProvided} lagu)*`;
              }
              await interaction.editReply({ content: msg });
              break;
            }
            case 'add': {
              const name = interaction.options.getString('name', true);
              const query = interaction.options.getString('query', true);
              await interaction.deferReply({ flags: MessageFlags.Ephemeral });
              const resolved = await ytdlp.resolve(query);
              if (!resolved.tracks || resolved.tracks.length === 0) {
                await interaction.editReply({ content: '❌ Lagu tidak ditemukan.' });
                break;
              }
              const track = resolved.tracks[0];
              const res = playlists.addTrack(interaction.guildId, interaction.user.id, name, track);
              await interaction.editReply({
                content: `✅ Menambahkan **${truncate(track.title, 80)}** ke playlist **${name}** (posisi #${res.position}, total ${res.trackCount}/${config.maxUserPlaylistTracks}).`
              });
              break;
            }
            case 'add-current': {
              const name = interaction.options.getString('name');
              if (!player.current) {
                await interaction.reply({ content: '❌ Tidak ada lagu yang sedang diputar saat ini.', flags: MessageFlags.Ephemeral });
                break;
              }
              if (!name) {
                const userPlaylists = playlists.getPlaylists(interaction.guildId, interaction.user.id);
                if (userPlaylists.length === 0) {
                  await interaction.reply({
                    content: 'Anda belum memiliki playlist di server ini. Buat dengan `/playlist create <nama>`.',
                    flags: MessageFlags.Ephemeral
                  });
                  break;
                }
                await interaction.reply({
                  content: `Pilih playlist tujuan untuk **${truncate(player.current.title, 80)}**:`,
                  components: [buildPlaylistSelectRow(userPlaylists, 'playlist:select_save_current', 'Pilih playlist tujuan...')],
                  flags: MessageFlags.Ephemeral
                });
                break;
              }
              const res = playlists.addTrack(interaction.guildId, interaction.user.id, name, {
                title: player.current.title,
                url: player.current.url || player.current.webpageUrl,
                uploader: player.current.uploader,
                duration: player.current.duration,
                thumbnail: player.current.thumbnail
              });
              await interaction.reply({
                content: `✅ Menambahkan lagu yang sedang diputar **${truncate(player.current.title, 80)}** ke playlist **${name}** (posisi #${res.position}, total ${res.trackCount}/${config.maxUserPlaylistTracks}).`,
                flags: MessageFlags.Ephemeral
              });
              break;
            }
            case 'play': {
              const name = interaction.options.getString('name');
              if (!name) {
                const userPlaylists = playlists.getPlaylists(interaction.guildId, interaction.user.id);
                if (userPlaylists.length === 0) {
                  await interaction.reply({
                    content: 'Anda belum memiliki playlist di server ini. Buat dengan `/playlist create <nama>` atau `/playlist import <nama> <url>`.',
                    flags: MessageFlags.Ephemeral
                  });
                  break;
                }
                await interaction.reply({
                  content: 'Pilih playlist yang ingin Anda putar:',
                  components: [buildPlaylistSelectRow(userPlaylists, 'playlist:select_play', 'Pilih playlist untuk diputar...')],
                  flags: MessageFlags.Ephemeral
                });
                break;
              }
              await interaction.deferReply();
              const tracks = playlists.getAllTracks(interaction.guildId, interaction.user.id, name);
              if (!tracks) {
                await interaction.editReply({ content: `❌ Playlist **${name}** tidak ditemukan.` });
                break;
              }
              if (tracks.length === 0) {
                await interaction.editReply({ content: `❌ Playlist **${name}** masih kosong. Tambah lagu dulu dengan \`/playlist add\`.` });
                break;
              }
              const member = await resolveMember(interaction);
              await player.playPlaylist({ member, textChannel: interaction.channel, name, tracks });
              await interaction.editReply({
                content: `▶️ Memutar playlist **${name}** (${tracks.length} lagu) ke antrean.`
              });
              break;
            }
            case 'list': {
              const list = playlists.getPlaylists(interaction.guildId, interaction.user.id);
              if (list.length === 0) {
                await interaction.reply({
                  content: 'Anda belum memiliki playlist di server ini. Buat dengan `/playlist create <nama>` atau `/playlist import <nama> <url>`.',
                  flags: MessageFlags.Ephemeral
                });
                break;
              }
              const embed = new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle(`Playlist Anda di Server Ini (${list.length}/${config.maxUserPlaylists})`)
                .setDescription(
                  list.map((pl, idx) => `${idx + 1}. **${pl.name}** — ${pl.trackCount}/${config.maxUserPlaylistTracks} lagu (${formatDuration(pl.totalDuration)})`).join('\n')
                )
                .setFooter({ text: 'Putar dengan /playlist play | Detail dengan /playlist view' });
              await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
              break;
            }
            case 'view': {
              const name = interaction.options.getString('name');
              const page = interaction.options.getInteger('page') || 1;
              if (!name) {
                const userPlaylists = playlists.getPlaylists(interaction.guildId, interaction.user.id);
                if (userPlaylists.length === 0) {
                  await interaction.reply({
                    content: 'Anda belum memiliki playlist di server ini. Buat dengan `/playlist create <nama>` atau `/playlist import <nama> <url>`.',
                    flags: MessageFlags.Ephemeral
                  });
                  break;
                }
                await interaction.reply({
                  content: 'Pilih playlist yang ingin Anda lihat:',
                  components: [buildPlaylistSelectRow(userPlaylists, 'playlist:select_view', 'Pilih playlist untuk dilihat...')],
                  flags: MessageFlags.Ephemeral
                });
                break;
              }
              const data = playlists.getPlaylistWithTracks(interaction.guildId, interaction.user.id, name, { page, pageSize: 10 });
              if (!data) {
                await interaction.reply({ content: `❌ Playlist **${name}** tidak ditemukan.`, flags: MessageFlags.Ephemeral });
                break;
              }
              if (data.totalTracks === 0) {
                await interaction.reply({ content: `Playlist **${data.playlist.name}** masih kosong.`, flags: MessageFlags.Ephemeral });
                break;
              }
              await interaction.reply({ embeds: [renderPlaylistViewEmbed(data)], flags: MessageFlags.Ephemeral });
              break;
            }
            case 'remove': {
              const name = interaction.options.getString('name');
              const position = interaction.options.getInteger('position');
              if (!name) {
                const userPlaylists = playlists.getPlaylists(interaction.guildId, interaction.user.id);
                if (userPlaylists.length === 0) {
                  await interaction.reply({
                    content: 'Anda belum memiliki playlist di server ini.',
                    flags: MessageFlags.Ephemeral
                  });
                  break;
                }
                await interaction.reply({
                  content: 'Pilih playlist yang lagunya ingin dihapus:',
                  components: [buildPlaylistSelectRow(userPlaylists, 'playlist:select_remove_pick_playlist', 'Pilih playlist...')],
                  flags: MessageFlags.Ephemeral
                });
                break;
              }
              if (!position) {
                const tracks = playlists.getAllTracks(interaction.guildId, interaction.user.id, name);
                if (!tracks) {
                  await interaction.reply({ content: `❌ Playlist **${name}** tidak ditemukan.`, flags: MessageFlags.Ephemeral });
                  break;
                }
                if (tracks.length === 0) {
                  await interaction.reply({ content: `Playlist **${name}** masih kosong.`, flags: MessageFlags.Ephemeral });
                  break;
                }
                const select = new StringSelectMenuBuilder()
                  .setCustomId(`playlist:select_remove_track:${encodeURIComponent(name)}`)
                  .setPlaceholder('Pilih lagu yang ingin dihapus...')
                  .addOptions(
                    tracks.slice(0, 25).map((t) => ({
                      label: `${t.position}. ${truncate(t.title, 45)}`,
                      description: `${truncate(t.uploader || 'Unknown', 30)} (${formatDuration(t.duration)})`,
                      value: String(t.position)
                    }))
                  );
                await interaction.reply({
                  content: `Pilih lagu dari **${name}** yang ingin dihapus:`,
                  components: [new ActionRowBuilder().addComponents(select)],
                  flags: MessageFlags.Ephemeral
                });
                break;
              }
              const res = playlists.removeTrack(interaction.guildId, interaction.user.id, name, position);
              await interaction.reply({
                content: `✅ Lagu **${truncate(res.removedTrack.title, 80)}** dihapus dari playlist **${name}**. Sisa: ${res.remainingCount} lagu.`,
                flags: MessageFlags.Ephemeral
              });
              break;
            }
            case 'delete': {
              const name = interaction.options.getString('name');
              if (!name) {
                const userPlaylists = playlists.getPlaylists(interaction.guildId, interaction.user.id);
                if (userPlaylists.length === 0) {
                  await interaction.reply({
                    content: 'Anda belum memiliki playlist di server ini.',
                    flags: MessageFlags.Ephemeral
                  });
                  break;
                }
                await interaction.reply({
                  content: 'Pilih playlist yang ingin Anda hapus:',
                  components: [buildPlaylistSelectRow(userPlaylists, 'playlist:select_delete', 'Pilih playlist yang akan dihapus...')],
                  flags: MessageFlags.Ephemeral
                });
                break;
              }
              playlists.deletePlaylist(interaction.guildId, interaction.user.id, name);
              await interaction.reply({
                content: `🗑️ Playlist **${name}** berhasil dihapus.`,
                flags: MessageFlags.Ephemeral
              });
              break;
            }
          }
          break;
        }
      }
    } catch (error) {
      const message = truncate(error.message || 'Unknown error', 1800);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: `Error: ${message}`, embeds: [] }).catch(() => null);
      } else {
        await interaction.reply({ content: `Error: ${message}`, flags: MessageFlags.Ephemeral }).catch(() => null);
      }
    }
  }

  if (interaction.isButton()) {
    const player = playerFor(interaction);
    try {
      if (interaction.customId.startsWith('cache:list:')) {
        const [, , sessionId, action] = interaction.customId.split(':');
        const session = getCacheListSession(sessionId);
        if (!session) {
          await interaction.reply({
            content: 'Sesi cache list sudah kedaluwarsa. Jalankan `/cache-list` lagi.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if (session.userId !== interaction.user.id) {
          await interaction.reply({
            content: 'Tombol ini hanya bisa dipakai oleh pembuat sesi cache list.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if (action === 'search') {
          const modal = new ModalBuilder()
            .setCustomId(`cache:list:search:${sessionId}`)
            .setTitle('Search Cache');
          const input = new TextInputBuilder()
            .setCustomId('query')
            .setLabel('Judul / keyword')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(100)
            .setValue(session.query || '')
            .setPlaceholder('Kosongkan untuk tampilkan semua lagu');

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          await interaction.showModal(modal);
          return;
        }

        if (action === 'prev') {
          session.page = Math.max(0, session.page - 1);
        } else if (action === 'next') {
          session.page += 1;
        }

        const view = await buildCacheListView(player, { query: session.query, page: session.page });
        session.page = view.page;
        await interaction.update({
          embeds: [view.embed],
          components: buildCacheListComponents(sessionId, view)
        });
        return;
      }

      switch (interaction.customId) {
        case 'player:toggle': {
          const paused = player.togglePause();
          await interaction.reply({ content: paused ? 'Playback dijeda.' : 'Playback dilanjutkan.', flags: MessageFlags.Ephemeral });
          scheduleInteractionDelete(interaction);
          break;
        }
        case 'player:skip': {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const skipped = await player.skip();
          await interaction.editReply({
            content: skipped ? 'Lagu dilewati.' : 'Skip sebelumnya masih diproses.'
          });
          scheduleInteractionDelete(interaction);
          break;
        }
        case 'player:stop':
          await player.stop({ disconnect: true });
          await interaction.reply({ content: 'Playback dihentikan.', flags: MessageFlags.Ephemeral });
          scheduleInteractionDelete(interaction);
          break;
        case 'player:shuffle':
          await interaction.reply({ content: `Queue diacak. Total: ${player.shuffle()}.`, flags: MessageFlags.Ephemeral });
          scheduleInteractionDelete(interaction);
          break;
        case 'player:autoplay':
          await interaction.reply({ content: `Autoplay \`${player.toggleAutoplay()}\`.`, flags: MessageFlags.Ephemeral });
          scheduleInteractionDelete(interaction);
          break;
        case 'player:loop':
          await interaction.reply({ content: `Loop mode diubah ke \`${player.nextLoopMode()}\`.`, flags: MessageFlags.Ephemeral });
          scheduleInteractionDelete(interaction);
          break;
        case 'player:queue':
          await interaction.reply({
            embeds: [new EmbedBuilder().setColor(0x00c2ff).setTitle('Queue').setDescription(player.queueLines().join('\n'))],
            flags: MessageFlags.Ephemeral
          });
          break;
        case 'player:lyrics': {
          await interaction.deferReply();
          const lyric = await player.lyricsForCurrent().catch(() => null);
          if (!lyric) {
            return await interaction.editReply({ content: '❌ Lirik tidak ditemukan untuk lagu ini.' });
          }
          const rawLyrics = lyric.syncedLyrics || lyric.plainLyrics || 'Lyrics kosong.';
          const cleanLyrics = rawLyrics.replace(/^\[\d{2}:\d{2}\.\d{2,}\]\s?/gm, '');
          const text = truncate(cleanLyrics, 3800);
          const msg = await interaction.editReply({
            embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle(`Lyrics: ${lyric.artistName} - ${lyric.trackName}`).setDescription(text)]
          });
          player.addLyricMessage(msg);
          break;
        }
        case 'player:playlist': {
          if (!player.current) {
            await interaction.reply({ content: 'Tidak ada lagu yang sedang diputar.', flags: MessageFlags.Ephemeral });
            break;
          }
          const userPlaylists = playlists.getPlaylists(interaction.guildId, interaction.user.id);
          if (userPlaylists.length === 0) {
            await interaction.reply({
              content: 'Anda belum memiliki playlist di server ini. Buat playlist baru terlebih dahulu dengan `/playlist create <nama>`.',
              flags: MessageFlags.Ephemeral
            });
            break;
          }
          const select = new StringSelectMenuBuilder()
            .setCustomId('playlist:select_save_current')
            .setPlaceholder('Pilih playlist tujuan...')
            .addOptions(
              userPlaylists.map((pl) => ({
                label: truncate(pl.name, 50),
                description: `${pl.trackCount}/${config.maxUserPlaylistTracks} lagu (${formatDuration(pl.totalDuration)})`,
                value: pl.name
              }))
            );
          const row = new ActionRowBuilder().addComponents(select);
          await interaction.reply({
            content: `Simpan lagu yang sedang diputar **${truncate(player.current.title, 80)}** ke:`,
            components: [row],
            flags: MessageFlags.Ephemeral
          });
          break;
        }
      }
    } catch (error) {
      const msg = `Error: ${truncate(error.message || 'Unknown error', 1800)}`;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: msg }).catch(() => null);
      } else {
        await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => null);
      }
    }
  }

  if (interaction.isModalSubmit()) {
    const player = playerFor(interaction);
    try {
      if (interaction.customId.startsWith('cache:list:search:')) {
        const sessionId = interaction.customId.split(':')[3];
        const session = getCacheListSession(sessionId);
        if (!session) {
          await interaction.reply({
            content: 'Sesi cache list sudah kedaluwarsa. Jalankan `/cache-list` lagi.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if (session.userId !== interaction.user.id) {
          await interaction.reply({
            content: 'Form ini hanya bisa dipakai oleh pembuat sesi cache list.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        session.query = interaction.fields.getTextInputValue('query').trim();
        session.page = 0;
        const view = await buildCacheListView(player, { query: session.query, page: 0 });
        await interaction.update({
          embeds: [view.embed],
          components: buildCacheListComponents(sessionId, view)
        });
      }
    } catch (error) {
      const msg = `Error: ${truncate(error.message || 'Unknown error', 1800)}`;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: msg }).catch(() => null);
      } else {
        await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => null);
      }
    }
  }

  if (interaction.isStringSelectMenu()) {
    try {
      if (interaction.customId === 'playlist:select_save_current') {
        const selectedPlaylistName = interaction.values[0];
        const player = playerFor(interaction);
        if (!player.current) {
          await interaction.update({ content: '❌ Tidak ada lagu yang sedang diputar saat ini.', components: [] });
          return;
        }
        const res = playlists.addTrack(interaction.guildId, interaction.user.id, selectedPlaylistName, {
          title: player.current.title,
          url: player.current.url || player.current.webpageUrl,
          uploader: player.current.uploader,
          duration: player.current.duration,
          thumbnail: player.current.thumbnail
        });
        await interaction.update({
          content: `✅ Menambahkan **${truncate(player.current.title, 80)}** ke playlist **${selectedPlaylistName}** (posisi #${res.position}, total ${res.trackCount}/${config.maxUserPlaylistTracks}).`,
          components: []
        });
      } else if (interaction.customId === 'playlist:select_play') {
        const selectedPlaylistName = interaction.values[0];
        const tracks = playlists.getAllTracks(interaction.guildId, interaction.user.id, selectedPlaylistName);
        if (!tracks || tracks.length === 0) {
          await interaction.update({ content: `❌ Playlist **${selectedPlaylistName}** masih kosong atau tidak ditemukan.`, components: [] });
          return;
        }
        const member = await resolveMember(interaction);
        const player = playerFor(interaction);
        await interaction.update({ content: `⏳ Memuat playlist **${selectedPlaylistName}** (${tracks.length} lagu)...`, components: [] });
        await player.playPlaylist({ member, textChannel: interaction.channel, name: selectedPlaylistName, tracks });
        await interaction.editReply({
          content: `▶️ Memutar playlist **${selectedPlaylistName}** (${tracks.length} lagu) ke antrean.`
        });
      } else if (interaction.customId === 'playlist:select_view') {
        const selectedPlaylistName = interaction.values[0];
        const data = playlists.getPlaylistWithTracks(interaction.guildId, interaction.user.id, selectedPlaylistName, { page: 1, pageSize: 10 });
        if (!data || data.totalTracks === 0) {
          await interaction.update({ content: `Playlist **${selectedPlaylistName}** masih kosong atau tidak ditemukan.`, components: [] });
          return;
        }
        await interaction.update({
          content: '',
          embeds: [renderPlaylistViewEmbed(data)],
          components: []
        });
      } else if (interaction.customId === 'playlist:select_delete') {
        const selectedPlaylistName = interaction.values[0];
        playlists.deletePlaylist(interaction.guildId, interaction.user.id, selectedPlaylistName);
        await interaction.update({
          content: `🗑️ Playlist **${selectedPlaylistName}** berhasil dihapus.`,
          components: []
        });
      } else if (interaction.customId === 'playlist:select_remove_pick_playlist') {
        const selectedPlaylistName = interaction.values[0];
        const tracks = playlists.getAllTracks(interaction.guildId, interaction.user.id, selectedPlaylistName);
        if (!tracks || tracks.length === 0) {
          await interaction.update({ content: `Playlist **${selectedPlaylistName}** masih kosong.`, components: [] });
          return;
        }
        const select = new StringSelectMenuBuilder()
          .setCustomId(`playlist:select_remove_track:${encodeURIComponent(selectedPlaylistName)}`)
          .setPlaceholder('Pilih lagu yang ingin dihapus...')
          .addOptions(
            tracks.slice(0, 25).map((t) => ({
              label: `${t.position}. ${truncate(t.title, 45)}`,
              description: `${truncate(t.uploader || 'Unknown', 30)} (${formatDuration(t.duration)})`,
              value: String(t.position)
            }))
          );
        await interaction.update({
          content: `Pilih lagu dari **${selectedPlaylistName}** yang ingin dihapus:`,
          components: [new ActionRowBuilder().addComponents(select)]
        });
      } else if (interaction.customId.startsWith('playlist:select_remove_track:')) {
        const playlistName = decodeURIComponent(interaction.customId.slice('playlist:select_remove_track:'.length));
        const position = Number(interaction.values[0]);
        const res = playlists.removeTrack(interaction.guildId, interaction.user.id, playlistName, position);
        await interaction.update({
          content: `✅ Lagu **${truncate(res.removedTrack.title, 80)}** dihapus dari playlist **${playlistName}**. Sisa: ${res.remainingCount} lagu.`,
          components: []
        });
      }
    } catch (error) {
      const msg = `Error: ${truncate(error.message || 'Unknown error', 1800)}`;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: msg, components: [] }).catch(() => null);
      } else {
        await interaction.update({ content: msg, components: [] }).catch(() => null);
      }
    }
  }
});

registerRuntimeHandlers();
void loginWithRetry();
