import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Putar lagu atau playlist').addStringOption((option) =>
    option.setName('query').setDescription('Judul lagu, URL video, atau playlist URL').setRequired(true)
  ),
  new SlashCommandBuilder().setName('offlinemode').setDescription('Mulai sesi playback hanya dari cache lokal')
    .addStringOption((option) =>
      option.setName('query').setDescription('Nama lagu atau artis di cache lokal').setRequired(true)
    ),
  new SlashCommandBuilder().setName('normalmode').setDescription('Paksa kembali ke mode playback normal'),
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
  new SlashCommandBuilder().setName('reconnect').setDescription('Sambung ulang voice connection'),
  new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Kelola dan putar playlist pribadi Anda')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Buat playlist kosong baru')
        .addStringOption((opt) => opt.setName('name').setDescription('Nama playlist (maks 50 karakter)').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('import')
        .setDescription('Salin playlist dari YouTube ke playlist baru')
        .addStringOption((opt) => opt.setName('name').setDescription('Nama playlist baru').setRequired(true))
        .addStringOption((opt) => opt.setName('url').setDescription('URL playlist YouTube').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Tambah satu lagu ke playlist')
        .addStringOption((opt) => opt.setName('name').setDescription('Nama playlist tujuan').setAutocomplete(true).setRequired(true))
        .addStringOption((opt) => opt.setName('query').setDescription('Judul atau URL lagu').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('add-current')
        .setDescription('Tambah lagu yang sedang diputar ke playlist')
        .addStringOption((opt) => opt.setName('name').setDescription('Nama playlist tujuan (opsional, ada dropdown)').setAutocomplete(true).setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('play')
        .setDescription('Putar seluruh lagu dari playlist ke antrean bot')
        .addStringOption((opt) => opt.setName('name').setDescription('Nama playlist (opsional, ada dropdown)').setAutocomplete(true).setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Lihat semua playlist milik Anda di server ini')
    )
    .addSubcommand((sub) =>
      sub
        .setName('view')
        .setDescription('Lihat daftar lagu di dalam playlist')
        .addStringOption((opt) => opt.setName('name').setDescription('Nama playlist (opsional, ada dropdown)').setAutocomplete(true).setRequired(false))
        .addIntegerOption((opt) => opt.setName('page').setDescription('Nomor halaman').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Hapus lagu dari playlist berdasarkan nomor urut')
        .addStringOption((opt) => opt.setName('name').setDescription('Nama playlist (opsional, ada dropdown)').setAutocomplete(true).setRequired(false))
        .addIntegerOption((opt) => opt.setName('position').setDescription('Nomor urut lagu (opsional, ada dropdown)').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Hapus seluruh playlist')
        .addStringOption((opt) => opt.setName('name').setDescription('Nama playlist (opsional, ada dropdown)').setAutocomplete(true).setRequired(false))
    )
].map((command) => command.toJSON());
