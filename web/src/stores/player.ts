import { createSignal } from 'solid-js';
import { api } from '../api/client';

export interface Track {
  id: number;
  track_id: string;
  title: string;
  artist: string;
  normalized_artist?: string;
  genre?: string;
  is_cover?: boolean;
  thumbnail: string;
  duration: number;
}

const [current, setCurrent] = createSignal<Track | null>(null);
const [queue, setQueue] = createSignal<Track[]>([]);
const [history, setHistory] = createSignal<Track[]>([]);
const [isPlaying, setIsPlaying] = createSignal(false);
const [currentTime, setCurrentTime] = createSignal(0);
const [duration, setDuration] = createSignal(0);
const [volume, setVolume] = createSignal(0.8);
const [isMuted, setIsMuted] = createSignal(false);
const [loopMode, setLoopMode] = createSignal<'off' | 'one' | 'all'>('off');
const [shuffle, setShuffle] = createSignal(false);
const [autoplay, setAutoplay] = createSignal(true);
const [crossfade, setCrossfade] = createSignal(false);
const [showLyrics, setShowLyrics] = createSignal(false);
const [lyrics, setLyrics] = createSignal<string | null>(null);
const [syncedLyrics, setSyncedLyrics] = createSignal<string | null>(null);
const [lyricsLoading, setLyricsLoading] = createSignal(false);

let audioEl: HTMLAudioElement | null = null;

function getAudio(): HTMLAudioElement {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.volume = volume();
    
    audioEl.addEventListener('timeupdate', () => {
      setCurrentTime(audioEl!.currentTime);
    });
    
    audioEl.addEventListener('loadedmetadata', () => {
      setDuration(audioEl!.duration);
    });
    
    audioEl.addEventListener('ended', () => {
      handleTrackEnd();
    });
    
    audioEl.addEventListener('play', () => setIsPlaying(true));
    audioEl.addEventListener('pause', () => setIsPlaying(false));
  }
  return audioEl;
}

async function handleTrackEnd() {
  const cur = current();
  if (!cur) return;

  // Add to history
  if (cur) {
    setHistory(prev => [cur, ...prev].slice(0, 100));
    // Log to server if authenticated
    try {
      await api.logListen(cur.id);
      window.dispatchEvent(new CustomEvent('omnia:history-updated'));
    } catch {}
  }

  const mode = loopMode();
  
  if (mode === 'one') {
    // Replay current track
    playTrack(cur);
    return;
  }

  const q = queue();
  
  if (mode === 'all') {
    // Add current to end of queue
    setQueue(prev => [...prev, cur]);
  }

  if (q.length > 0) {
    // Play next in queue
    const next = q[0];
    setQueue(prev => prev.slice(1));
    playTrack(next);
  } else if (autoplay()) {
    // Fetch recommendations
    try {
      const recs = await api.getRecommendations(cur.id, 10);
      if (recs.length > 0) {
        const next = recs[0];
        setQueue(recs.slice(1));
        playTrack(next);
      }
    } catch {}
  } else {
    setCurrent(null);
    setIsPlaying(false);
  }
}

export function playTrack(track: Track) {
  const audio = getAudio();
  setCurrent(track);
  audio.src = api.streamUrl(track.id);
  audio.play().catch(() => {});
  
  // Fetch lyrics in background
  if (showLyrics()) {
    fetchLyrics(track.id);
  }
}

export function playTrackFromList(track: Track, list: Track[]) {
  const idx = list.findIndex(t => t.id === track.id);
  if (idx >= 0) {
    const remaining = list.slice(idx + 1);
    if (shuffle()) {
      setQueue(shuffleArray([...remaining]));
    } else {
      setQueue(remaining);
    }
  }
  playTrack(track);
}

export function togglePlay() {
  const audio = getAudio();
  if (!current()) return;
  
  if (isPlaying()) {
    audio.pause();
  } else {
    audio.play().catch(() => {});
  }
}

export function seek(time: number) {
  const audio = getAudio();
  audio.currentTime = time;
}

export function changeVolume(v: number) {
  setVolume(v);
  if (audioEl) audioEl.volume = v;
  if (v > 0) setIsMuted(false);
}

export function toggleMute() {
  const audio = getAudio();
  if (isMuted()) {
    audio.volume = volume();
    setIsMuted(false);
  } else {
    audio.volume = 0;
    setIsMuted(true);
  }
}

export function nextTrack() {
  handleTrackEnd();
}

export function prevTrack() {
  const hist = history();
  if (hist.length > 0) {
    const prev = hist[0];
    setHistory(h => h.slice(1));
    // Put current at front of queue
    const cur = current();
    if (cur) {
      setQueue(q => [cur, ...q]);
    }
    playTrack(prev);
  } else {
    // Restart current track
    if (audioEl) audioEl.currentTime = 0;
  }
}

export function cycleLoopMode() {
  const modes: Array<'off' | 'one' | 'all'> = ['off', 'one', 'all'];
  const idx = modes.indexOf(loopMode());
  setLoopMode(modes[(idx + 1) % modes.length]);
}

export function toggleShuffle() {
  setShuffle(s => !s);
  if (!shuffle()) {
    // Shuffle current queue
    setQueue(q => shuffleArray([...q]));
  }
}

export function toggleCrossfade() {
  setCrossfade(c => !c);
}

export function toggleAutoplay() {
  setAutoplay(a => !a);
}

export function toggleLyrics() {
  const show = !showLyrics();
  setShowLyrics(show);
  if (show && current()) {
    fetchLyrics(current()!.id);
  }
}

async function fetchLyrics(trackId: number) {
  setLyricsLoading(true);
  try {
    const data = await api.getLyrics(trackId);
    setLyrics(data.lyrics);
    setSyncedLyrics(data.synced_lyrics);
  } catch {
    setLyrics(null);
    setSyncedLyrics(null);
  }
  setLyricsLoading(false);
}

function shuffleArray<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function addToQueue(track: Track) {
  setQueue(q => [...q, track]);
}

export function removeFromQueue(trackId: number) {
  setQueue(q => q.filter(t => t.id !== trackId));
}

export function clearQueue() {
  setQueue([]);
}

export {
  current, queue, history, isPlaying, currentTime, duration,
  volume, isMuted, loopMode, shuffle, autoplay, crossfade,
  showLyrics, lyrics, syncedLyrics, lyricsLoading,
};
