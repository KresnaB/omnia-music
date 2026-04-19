import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes
} from 'discord.js';
import { config, validateConfig } from './config.js';
import { commands } from './discord/commands.js';
import { AudioCacheService } from './services/audioCache.js';
import { LyricsService } from './services/lyrics.js';
import { YTDlpService } from './services/ytdlp.js';
import { PlayerManager } from './player/PlayerManager.js';
import { formatBytes, formatDuration, isTransientNetworkError, truncate } from './utils/format.js';

validateConfig();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const ytdlp = new YTDlpService();
const audioCache = new AudioCacheService();
const lyrics = new LyricsService();
const players = new PlayerManager({ client, ytdlp, lyrics, audioCache });
const AUTO_DELETE_MS = 5000;
const LOGIN_RETRY_BASE_DELAY_MS = 5_000;
const LOGIN_RETRY_MAX_DELAY_MS = 60_000;
let networkOutageDetected = false;

function helpEmbed() {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle('Omnia Music Help')
    .setDescription(
      [
        '`/play <query>` putar lagu atau playlist',
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
        '`/reconnect` sambung ulang voice'
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

function statusEmbed(player) {
  const status = player.status();
  const lines = [
    `Connected: \`${status.connected}\``,
    `Paused: \`${status.paused}\``,
    `Loop: \`${status.loopMode}\``,
    `Autoplay: \`${status.autoplay}\``,
    `Queue size: \`${status.queueSize}\``,
    `YouTube: \`${status.youtubeStatus}\``
  ];

  if (status.youtubeFailureReason) {
    lines.push(`YouTube reason: ${truncate(status.youtubeFailureReason, 120)}`);
  }

  if (status.current) {
    lines.push(`Current: **${status.current.title}**`);
  }

  if (status.sleepUntil) {
    lines.push(`Sleep until: <t:${Math.floor(status.sleepUntil / 1000)}:R>`);
  }

  return new EmbedBuilder().setColor(0x2ecc71).setTitle('Player Status').setDescription(lines.join('\n'));
}

function scheduleInteractionDelete(interaction, delayMs = AUTO_DELETE_MS) {
  setTimeout(() => {
    interaction.deleteReply().catch(() => null);
  }, delayMs);
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

client.on('interactionCreate', async (interaction) => {
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
        case 'skip':
          await player.skip();
          await interaction.reply({ content: 'Lagu dilewati.', flags: MessageFlags.Ephemeral });
          scheduleInteractionDelete(interaction);
          break;
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
          await interaction.reply({ embeds: [statusEmbed(player)], flags: MessageFlags.Ephemeral });
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
          const result = await player.audioCache.listEntries({ query, limit: 20 });
          const lines = result.entries.map((entry, index) =>
            `${index + 1}. ${truncate(entry.track?.title || entry.canonicalKey, 80)} | ${formatDuration(entry.track?.duration || 0)} | ${formatBytes(entry.sizeBytes)}`
          );

          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor(0x1abc9c)
                .setTitle(query ? `Cache List: ${truncate(query, 80)}` : 'Cache List')
                .setDescription(
                  lines.length > 0
                    ? `${lines.join('\n')}\n\nMenampilkan ${result.entries.length} dari ${result.total} lagu cache.`
                    : 'Cache kosong atau tidak ada hasil untuk filter tersebut.'
                )
            ],
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
      switch (interaction.customId) {
        case 'player:toggle': {
          const paused = player.togglePause();
          await interaction.reply({ content: paused ? 'Playback dijeda.' : 'Playback dilanjutkan.', flags: MessageFlags.Ephemeral });
          scheduleInteractionDelete(interaction);
          break;
        }
        case 'player:skip':
          await player.skip();
          await interaction.reply({ content: 'Lagu dilewati.', flags: MessageFlags.Ephemeral });
          scheduleInteractionDelete(interaction);
          break;
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
});

registerRuntimeHandlers();
void loginWithRetry();
