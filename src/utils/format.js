export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':');
  }

  return [minutes, secs].map((part) => String(part).padStart(2, '0')).join(':');
}

export function truncate(value, max) {
  if (!value) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

export function nowUnixPlus(ms) {
  return Math.floor((Date.now() + ms) / 1000);
}

export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes || 0));
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

export function isTransientNetworkError(error) {
  const text = `${error?.code || ''} ${error?.name || ''} ${error?.message || ''}`.toLowerCase();
  return /aborted|network|socket|websocket|econnreset|etimedout|eai_again|enotfound|ecanceled|gateway|connect|disconnect|getaddrinfo|name resolution|googlevideo/.test(text);
}
