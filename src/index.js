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
import { LyricsService } from './services/lyrics.js';
import { YTDlpService } from './services/ytdlp.js';
import { PlayerManager } from './player/PlayerManager.js';
import { truncate } from './utils/format.js';

validateConfig();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const ytdlp = new YTDlpService();
const lyrics = new LyricsService();
const players = new PlayerManager({ client, ytdlp, lyrics });

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
    `Queue size: \`${status.queueSize}\``
  ];

  if (status.current) {
    lines.push(`Current: **${status.current.title}**`);
  }

  if (status.sleepUntil) {
    lines.push(`Sleep until: <t:${Math.floor(status.sleepUntil / 1000)}:R>`);
  }

  return new EmbedBuilder().setColor(0x2ecc71).setTitle('Player Status').setDescription(lines.join('\n'));
}

client.once('clientReady', async () => {
  await registerCommands();
  console.log(`Omnia Music is online as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const player = playerFor(interaction);

    try {
      switch (interaction.commandName) {
        case 'play': {
          await interaction.deferReply();
          const query = interaction.options.getString('query', true);
          const member = await resolveMember(interaction);
          const result = await player.enqueue({
            member,
            textChannel: interaction.channel,
            query
          });

          if (result.type === 'playlist') {
            await interaction.editReply({
              content: `Playlist **${truncate(result.playlistTitle, 120)}** dimasukkan ke queue: ${result.tracks.length} lagu pertama.`
            });
          } else {
            await interaction.editReply({ content: `Menambahkan **${truncate(result.tracks[0].title, 120)}** ke queue.` });
          }
          break;
        }
        case 'skip':
          await player.skip();
          await interaction.reply({ content: 'Lagu dilewati.', flags: MessageFlags.Ephemeral });
          break;
        case 'stop':
          await player.stop({ disconnect: true });
          await interaction.reply({ content: 'Playback dihentikan.', flags: MessageFlags.Ephemeral });
          break;
        case 'seek':
          await player.seek(interaction.options.getInteger('seconds', true));
          await interaction.reply({ content: 'Playback dipindahkan.', flags: MessageFlags.Ephemeral });
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
          break;
        case 'shuffle':
          await interaction.reply({ content: `Queue diacak. Total: ${player.shuffle()}.`, flags: MessageFlags.Ephemeral });
          break;
        case 'autoplay':
          await interaction.reply({ content: `Autoplay \`${player.toggleAutoplay()}\`.`, flags: MessageFlags.Ephemeral });
          break;
        case 'help':
          await interaction.reply({ embeds: [helpEmbed()], flags: MessageFlags.Ephemeral });
          break;
        case 'move':
          player.move(interaction.options.getInteger('from', true), interaction.options.getInteger('to', true));
          await interaction.reply({ content: 'Queue diperbarui.', flags: MessageFlags.Ephemeral });
          break;
        case 'status':
          await interaction.reply({ embeds: [statusEmbed(player)], flags: MessageFlags.Ephemeral });
          break;
        case 'lyrics': {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const lyric = await player.lyricsForCurrent();
          const text = truncate(lyric.syncedLyrics || lyric.plainLyrics || 'Lyrics kosong.', 3800);
          await interaction.editReply({
            embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle(`Lyrics: ${lyric.artistName} - ${lyric.trackName}`).setDescription(text)]
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
          break;
        }
        case 'player:skip':
          await player.skip();
          await interaction.reply({ content: 'Lagu dilewati.', flags: MessageFlags.Ephemeral });
          break;
        case 'player:stop':
          await player.stop({ disconnect: true });
          await interaction.reply({ content: 'Playback dihentikan.', flags: MessageFlags.Ephemeral });
          break;
        case 'player:shuffle':
          await interaction.reply({ content: `Queue diacak. Total: ${player.shuffle()}.`, flags: MessageFlags.Ephemeral });
          break;
        case 'player:autoplay':
          await interaction.reply({ content: `Autoplay \`${player.toggleAutoplay()}\`.`, flags: MessageFlags.Ephemeral });
          break;
        case 'player:loop':
          await interaction.reply({ content: `Loop mode diubah ke \`${player.nextLoopMode()}\`.`, flags: MessageFlags.Ephemeral });
          break;
        case 'player:queue':
          await interaction.reply({
            embeds: [new EmbedBuilder().setColor(0x00c2ff).setTitle('Queue').setDescription(player.queueLines().join('\n'))],
            flags: MessageFlags.Ephemeral
          });
          break;
        case 'player:lyrics': {
          const lyric = await player.lyricsForCurrent();
          const text = truncate(lyric.syncedLyrics || lyric.plainLyrics || 'Lyrics kosong.', 3800);
          await interaction.reply({
            embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle(`Lyrics: ${lyric.artistName} - ${lyric.trackName}`).setDescription(text)],
            flags: MessageFlags.Ephemeral
          });
          break;
        }
      }
    } catch (error) {
      await interaction.reply({
        content: `Error: ${truncate(error.message || 'Unknown error', 1800)}`,
        flags: MessageFlags.Ephemeral
      }).catch(() => null);
    }
  }
});

client.login(config.discordToken);
