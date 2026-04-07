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
