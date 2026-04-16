import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Putar lagu atau playlist').addStringOption((option) =>
    option.setName('query').setDescription('Judul lagu, URL video, atau playlist URL').setRequired(true)
  ),
  new SlashCommandBuilder().setName('skip').setDescription('Lewati lagu saat ini'),
  new SlashCommandBuilder().setName('stop').setDescription('Hentikan playback'),
  new SlashCommandBuilder().setName('seek').setDescription('Pindah posisi playback').addIntegerOption((option) =>
    option.setName('seconds').setDescription('Posisi detik').setRequired(true)
  ),
  new SlashCommandBuilder().setName('queue').setDescription('Lihat antrean lagu'),
  new SlashCommandBuilder().setName('loop').setDescription('Atur mode loop').addStringOption((option) =>
    option
      .setName('mode')
      .setDescription('Mode loop')
      .setRequired(true)
      .addChoices(
        { name: 'off', value: 'off' },
        { name: 'track', value: 'track' },
        { name: 'queue', value: 'queue' }
      )
  ),
  new SlashCommandBuilder().setName('shuffle').setDescription('Acak queue'),
  new SlashCommandBuilder().setName('autoplay').setDescription('Toggle autoplay'),
  new SlashCommandBuilder().setName('help').setDescription('Lihat bantuan command'),
  new SlashCommandBuilder().setName('move').setDescription('Pindahkan posisi queue')
    .addIntegerOption((option) => option.setName('from').setDescription('Posisi asal').setRequired(true))
    .addIntegerOption((option) => option.setName('to').setDescription('Posisi tujuan').setRequired(true)),
  new SlashCommandBuilder().setName('status').setDescription('Status player'),
  new SlashCommandBuilder().setName('lyrics').setDescription('Ambil lirik lagu aktif'),
  new SlashCommandBuilder().setName('cache-stats').setDescription('Lihat jumlah lagu dan ukuran cache'),
  new SlashCommandBuilder().setName('cache-list').setDescription('Lihat daftar lagu di cache')
    .addStringOption((option) => option.setName('query').setDescription('Filter judul cache').setRequired(false)),
  new SlashCommandBuilder().setName('cache-delete').setDescription('Hapus lagu dari cache')
    .addStringOption((option) => option.setName('query').setDescription('Judul lagu cache yang akan dihapus').setRequired(true)),
  new SlashCommandBuilder().setName('sleep').setDescription('Set sleep timer').addIntegerOption((option) =>
    option.setName('minutes').setDescription('Jumlah menit').setRequired(true)
  ),
  new SlashCommandBuilder().setName('reconnect').setDescription('Sambung ulang voice connection')
].map((command) => command.toJSON());
