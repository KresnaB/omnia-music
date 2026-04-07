import 'dotenv/config';

function toInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const config = {
  discordToken: process.env.DISCORD_TOKEN ?? '',
  clientId: process.env.DISCORD_CLIENT_ID ?? '',
  devGuildId: process.env.DEV_GUILD_ID ?? '',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ytDlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  ytDlpCookiesFile: process.env.YTDLP_COOKIES_FILE || '',
  ytDlpYoutubeArgs: process.env.YTDLP_YOUTUBE_EXTRACTOR_ARGS || 'youtube:player_client=default,mweb',
  ytDlpPotProviderArgs:
    process.env.YTDLP_POT_PROVIDER_ARGS ||
    'youtubepot-bgutilhttp:base_url=http://bgutil-pot:4416;disable_innertube=1',
  lrclibBaseUrl: process.env.LRCLIB_BASE_URL || 'https://lrclib.net',
  defaultVolume: toInt(process.env.DEFAULT_VOLUME, 100),
  defaultIdleTimeoutMs: toInt(process.env.DEFAULT_IDLE_TIMEOUT_MS, 10 * 60 * 1000),
  defaultSearchPlatform: process.env.DEFAULT_SEARCH_PLATFORM || 'youtube',
  maxPlaylistTracks: 100
};

export function validateConfig() {
  const missing = [];
  if (!config.discordToken) missing.push('DISCORD_TOKEN');
  if (!config.clientId) missing.push('DISCORD_CLIENT_ID');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
