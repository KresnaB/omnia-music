# Omnia Music — Comprehensive Analysis Report

## 1. Architecture Overview

### Stack
- **Backend**: Go 1.x + Fiber (v2) web framework, SQLite (mattn/go-sqlite3), JWT auth (golang-jwt/jwt/v5)
- **Frontend**: Solid.js ^1.9.5 + TypeScript + @solidjs/router ^0.15.3, Vite 6 bundler
- **DB Path**: `./data/omnia.db` (default)
- **Audio**: Streamed from local file path via `file_name` column; YouTube-cached Ogg/Opus files
- **Auth**: JWT tokens, CAPTCHA challenge on login, rate-limiting (5 attempts/15min per IP)

### Directory Layout
```
/omnia-music
├── server/                  # Go backend
│   ├── main.go              # Fiber app setup, route registration
│   ├── config/config.go     # Env-based config
│   ├── database/db.go       # SQLite init, migrations, track import/enrichment
│   ├── middleware/auth.go    # JWT middleware (AuthRequired, AuthQueryOrHeader)
│   ├── handlers/
│   │   ├── auth.go          # Register, Login, GetMe, CAPTCHA
│   │   ├── tracks.go        # CRUD + search + stream + lyrics + recommendations + foryou + artists + genres
│   │   ├── playlists.go     # CRUD for playlists + add/remove tracks
│   │   ├── albums.go        # List albums, get album detail, get artist albums
│   │   ├── history.go       # Get/listen log/delete history
│   │   └── settings.go      # Crossfade toggle
│   └── models/
│       ├── track.go
│       ├── user.go
│       ├── playlist.go
│       ├── album.go
│       ├── history.go
│       └── settings.go
├── web/                     # Solid.js frontend
│   └── src/
│       ├── App.tsx          # Router + layout
│       ├── index.tsx        # Entry point
│       ├── api/client.ts    # API client with auth header management
│       ├── stores/
│       │   ├── auth.ts      # Auth state (login, register, logout, init)
│       │   └── player.ts    # Audio playback engine + queue + lyrics
│       ├── pages/
│       │   ├── Home.tsx            # Beranda (for-you, recently played, charts)
│       │   ├── Search.tsx          # Global search (tabs: songs/artists/albums/playlists)
│       │   ├── Artists.tsx         # Artist grid + detail view
│       │   ├── Albums.tsx          # Album grid
│       │   ├── AlbumDetail.tsx     # Album detail with tracks
│       │   ├── Playlists.tsx       # Playlist list + create
│       │   ├── PlaylistDetail.tsx  # Playlist detail
│       │   ├── History.tsx         # Listening history
│       │   └── Login.tsx           # Login/register with CAPTCHA
│       ├── components/
│       │   ├── Sidebar.tsx                  # Desktop nav
│       │   ├── MobileNav.tsx                # Mobile bottom nav
│       │   ├── PlayerBar.tsx                # Bottom player + mobile expand + fullscreen
│       │   ├── DesktopFullscreenPlayer.tsx  # Full-screen player overlay
│       │   ├── TrackList.tsx                # Reusable track listing
│       │   ├── TrackMenu.tsx                # Three-dot context menu
│       │   ├── LyricsPanel.tsx              # Sidebar lyrics panel
│       │   └── Breadcrumbs.tsx              # Navigation breadcrumbs
│       └── styles.css     # 2640 lines of CSS (all styles in one file)
```

---

## 2. Routing (Frontend)

| Route | Page | Status |
|---|---|---|
| `/login` | Login | ✅ Works |
| `/` | Home | ✅ Works |
| `/search` | Search | ✅ Works |
| `/artists` | Artists (grid) | ✅ Works |
| `/artists?artist=X` | Artists (detail) | ✅ Works |
| `/albums` | Albums (grid) | ✅ Works |
| `/albums/:name` | AlbumDetail | ✅ Works |
| `/playlists` | Playlists (list) | ✅ Works |
| `/playlists/:id` | PlaylistDetail | ⚠️ Missing remove track UI |
| `/history` | History | ✅ Works |

**Missing routes**: No `/queue` page (queue is inline in fullscreen player only), no settings/profile page.

---

## 3. API Endpoints (Backend)

### Auth
| Method | Path | Auth | Status |
|---|---|---|---|
| POST | `/api/auth/register` | Public | ✅ Works |
| POST | `/api/auth/login` | Public | ✅ CAPTCHA-protected |
| GET | `/api/auth/captcha` | Public | ✅ Math CAPTCHA |
| GET | `/api/auth/me` | Required | ✅ |

### Tracks
| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/api/tracks/` | Required | ✅ Paginated, filterable |
| GET | `/api/tracks/search` | Required | ✅ Multi-type search |
| GET | `/api/tracks/recommendations` | Required | ✅ Genre/artist-based |
| POST | `/api/tracks/sync` | Required | ✅ Re-import new tracks |
| GET | `/api/tracks/:id` | Required | ✅ Single track |
| GET | `/api/tracks/:id/stream` | Query/Header | ✅ Audio streaming |

### Artists & Genres
| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/api/artists` | Required | ✅ Aggregated from tracks |
| GET | `/api/genres` | Required | ✅ Aggregated from tracks |

### Albums
| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/api/albums` | Required | ✅ Paginated |
| GET | `/api/albums/*` | Required | ✅ By name |
| GET | `/api/artists/:name/albums` | Required | ✅ By artist |

### Playlists
| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/api/playlists/` | Required | ✅ User-scoped |
| POST | `/api/playlists/` | Required | ✅ Create |
| GET | `/api/playlists/:id` | Required | ✅ With tracks |
| PUT | `/api/playlists/:id` | Required | ✅ Update |
| DELETE | `/api/playlists/:id` | Required | ✅ Delete |
| POST | `/api/playlists/:id/tracks` | Required | ✅ Add track |
| DELETE | `/api/playlists/:id/tracks/:trackId` | Required | ✅ Remove track |

### History
| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/api/history/` | Required | ✅ With track joins |
| POST | `/api/history/` | Required | ✅ Log listen |
| DELETE | `/api/history/:id` | Required | ✅ Delete entry |

### Other
| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/api/foryou` | Required | ✅ Personalized home |
| GET | `/api/lyrics` | Required | ✅ Via LRCLIB |
| GET | `/api/settings/crossfade` | Required | ✅ |
| POST | `/api/settings/crossfade` | Required | ✅ |

---

## 4. Database Models

### `tracks`
Key columns: `id, track_id, canonical_key, file_name, title, artist, normalized_artist, genre, is_cover, album, thumbnail, duration, size_bytes, source, cache_format, cache_codec, cache_bitrate`

The `album` column is overridden: for YouTube-sourced tracks without album metadata, `album` defaults to `normalized_artist` (artist name as album). The `albums` VIEW in SQLite filters out `album = normalized_artist`, showing only "real" albums.

### `playlists` + `playlist_tracks`
Standard user-playlist-tracks junction. `playlist_tracks.track_id` references `tracks.id`.

### `history`
Logs per user per track with timestamp. Joined with `tracks` on read.

### `settings`
Simple key-value store for persistent settings (currently only `crossfade`).

### `users`
Standard: `id, username, password_hash (bcrypt), created_at`.

---

## 5. Feature-by-Feature Analysis

### 5.1 Home Page (`pages/Home.tsx`)

**What it does**:
- Fetches `/api/foryou` for personalized content (recently played, top artists, top genres, for-you recommendations)
- Fetches Indonesian tracks (`genre=Indonesian, sort=random`) and global tracks (`sort=random`) as "Top 100" charts
- Fetches user playlists
- Auto-refreshes every 5 minutes; listens for `omnia:history-updated` custom event

**Issues**:
1. **"Top 100" charts are actually random 100 tracks**, not real charts. The backend has no popularity metric. The frontend labels them as "Top 100 Indonesia" and "Top 100 Global" but they're just random genre/mixed tracks.
2. **Duplicate track-menu logic**: The Home page has its own `openMenu`/`closeMenu`/`menuTrack`/`menuPos` state instead of delegating to `TrackList`'s built-in menu handling. This means the "For You" section and "Recently Played" sections have inline menus that duplicate (and slightly differ from) the `TrackList` component's menu.
3. **No playlist track count**: The playlist cards in the home page reference `pl.track_count || 0`, but the `/api/playlists` endpoint does NOT return `track_count`. It will always show 0.
4. **Infinite auto-refresh**: The `setInterval(load, 5*60*1000)` is never cleaned up. If the component unmounts, the interval keeps firing and setting state on unmounted components.
5. **No loading state for individual sections**: Only a single global `loading` state. Once loaded, sections appear/disappear without individual loading indicators.

### 5.2 Artists Page (`pages/Artists.tsx`)

**What it does**:
- Grid of artists (from `/api/artists`) with genre filter chips
- Clicking an artist shows: track list (top 10 + "show all"), albums, playlists, similar artists

**Issues**:
1. **`getSimilarArtists` API endpoint DOES NOT EXIST**: The frontend calls `api.getSimilarArtists(artist)` which hits `/api/artists/similar?artist=X`. But the backend has NO route for `/api/artists/similar`. The only routes are:
   - `GET /api/artists` → `GetArtists`
   - `GET /api/artists/:name/albums` → `GetArtistAlbums`
   - The `/similar` route would match `/:name` as the wildcard, but since `similar` would be the `:name` param, the route would look for albums of an artist named "similar", which would return empty. **The Similiar Artists section will always be empty and throw a console error.**
2. **`getArtistPlaylists` API endpoint DOES NOT EXIST**: The frontend calls `api.getArtistPlaylists(artist)` which hits `/api/playlists?artist=X`. The backend playlist handler does NOT support an `artist` query parameter. The `GetPlaylists` handler only accepts `user_id` from JWT claims. **The Playlist section in artist detail will always be empty.**
3. **No back navigation from artist detail**: When clicking an artist, the URL changes to `/artists?artist=X`. Pressing the browser back button returns to the artist grid, but the artist detail state is not preserved from URL alone — the `selectedArtist` signal is reset. This is semi-solved by the `onMount` check for `searchParams.artist`, but clicking browser forward again won't restore state.
4. **Albums in artist detail use `album.name || album.album_name`**: The backend `GetArtistAlbums` returns objects with `name`, `artist`, `thumbnail`, `track_count`, `total_duration` (from the `albums` VIEW which uses `album AS name` column alias... wait, let me check — the VIEW uses `album`, `normalized_artist AS artist`, etc. So `album` is the field name, not `name`. But the model uses `Name string` JSON tag `"name"`. So it should be `album.name`. The `fallback` to `album_name` is unnecessary but harmless.
5. **Similar artists has no actual backend implementation**: The backend `GetArtists` handler returns artists aggregated from `tracks` table. There is no collaborative filtering, no "artists listened to by same users" logic.
6. **No pagination in artist detail**: Only 100 tracks are fetched. If an artist has more than 100 tracks, they won't show.

### 5.3 Playlists Page (`pages/Playlists.tsx`)

**Issues**:
1. **Missing `track_count` in response**: The frontend shows `pl.track_count || 0` in playlist cards, but the backend `GetPlaylists` handler calls `models.GetPlaylistsByUser` which only selects `id, user_id, name, description, created_at, updated_at` — no track count. Every playlist shows "0 lagu".
2. **No playlist thumbnail/art**: Just a generic `library_music` icon.
3. **No drag-to-reorder**: Playlist tracks have no position reordering capability.
4. **Delete button is always visible**: The delete button on each playlist card has no confirmation animation or undo capability beyond the `confirm()` dialog.

### 5.4 Playlist Detail (`pages/PlaylistDetail.tsx`)

**Issues**:
1. **No "Remove from Playlist" integration**: The `TrackList` component supports `showRemoveFromPlaylist` and `onRemoveFromPlaylist` props, but `PlaylistDetail` does NOT pass them. The `removeTrack` function exists in the component but is never wired to the UI. Users cannot remove tracks from a playlist via the detail view.
2. **No play-all button**: Unlike `AlbumDetail` and `Artists`, the playlist detail has no "Play All" button.
3. **No playlist metadata editing**: The UI has no way to edit playlist name or description (the API supports PUT).
4. **Track mapping is fragile**: The `tracks()` computed function maps `pt.track?.id || pt.track_id`. If the backend returns incomplete track data (e.g., `pt.track` is null), the track will have `id: pt.track_id` (which is the playlist_tracks db id, not the actual track id). This could cause playback to play the wrong track.
5. **No queue integration**: When playing a track from a playlist, the queue should be the full playlist. The `TrackList` is called without `queueTracks`, so it defaults to the displayed tracks list — but this is fine since `queueTracks` falls back to `props.tracks`.

### 5.5 TrackMenu Component (`components/TrackMenu.tsx`)

**Issues**:
1. **"Go to Album" is a no-op**: The `handleGoToAlbum` function is completely empty — it just calls `props.onClose()` and does nothing else. Clicking "Ke Album" closes the menu but does nothing.
2. **No queue count/position feedback**: When selecting "Putar Selanjutnya", there's no visual feedback about where in the queue the track was added.
3. **Playlist picker uses inline fetch**: Each time the menu opens and user clicks "Add to Playlist", it re-fetches the playlist list. This could be cached.
4. **No "Create New Playlist" flow**: The playlist picker's "Buat Playlist" button navigates away to `/playlists` instead of offering inline creation.
5. **Menu positioning can overflow**: The `x` position calculation uses `Math.min(rect.right - 200, window.innerWidth - 220)` which works for right-aligned menus but doesn't handle edge cases near the bottom of the viewport.

### 5.6 TrackList Component (`components/TrackList.tsx`)

**Issues**:
1. **`track_idx` shows `false` when `showIndex` is false**: In `History.tsx`, `showIndex={false}` is passed. The template `props.showIndex !== false ? i() + 1 : ''` correctly handles this, but when `showIndex` is `false`, the ternary evaluates to `false` (not `''`). Since `false` renders nothing in JSX, this is fine visually, but it's not semantically clean.
2. **Cover badge shows `track.is_cover` but many tracks don't have this field**: The `Track` type has `is_cover?: boolean` as optional. If undefined, `track.is_cover && <CoverBadge/>` correctly evaluates to false, so no issue.
3. **No lazy loading/pagination**: The TrackList shows all tracks at once. For large lists (>100 items), this could be slow.

### 5.7 Search Page (`pages/Search.tsx`)

**Issues**:
1. **No search query in URL**: If you search, then navigate elsewhere and come back, the search is lost. The query could be stored in URL search params.
2. **Debounce timer never cleaned up**: The `debounceTimer` is set but never cleared on component unmount.
3. **Search results tab counts update before content**: The tab labels update immediately when results arrive, but the tab content is conditionally rendered — this is fine visually.
4. **No keyboard shortcut**: Ctrl+K or "/" to focus search is not implemented.

### 5.8 Album Detail (`pages/AlbumDetail.tsx`)

**Issues**:
1. **`album()?.year` is always empty**: The frontend renders `album()?.year || ''` but the backend's `GetAlbumByName` does not return a `year` field. The `albums` VIEW/`Album` model has no `year` column. This will always be blank.
2. **No back button on albums page itself** (the grid page): Only the detail page has a back button.
3. **Track `artist` field might differ from album artist**: The tracks query uses `artist` column from tracks table (raw uploader), not `normalized_artist`. Meanwhile the album detail shows `album()?.artist` (which is `normalized_artist` from the VIEW). Individual track rows might show a different artist name than the album header.

### 5.9 History Page (`pages/History.tsx`)

**Issues**:
1. **No delete functionality in UI**: The API has `deleteHistoryEntry` endpoint, and the page fetches history, but there's no delete button on individual history items. Users cannot clear their history.
2. **No group-by-date**: The history list is flat, not grouped by date (e.g., "Today", "Yesterday", "This Week").
3. **Track mapping same fragility as PlaylistDetail**: Uses the same `h.track?.id || h.track_id` pattern.

### 5.10 Player (`stores/player.ts` + `PlayerBar.tsx`)

**Issues**:
1. **`prevTrack` uses local history, not server history**: The `prevTrack` function uses a local in-memory `history` signal, which is populated when a track ends. If the user hasn't listened to anything yet in this session, `prevTrack` just restarts the current track. The server-side history is not used.
2. **Crossfade is client-side only**: The `crossfade` signal exists, and there's a server-side setting for it, but the actual crossfade logic is NOT implemented in the audio player. The `toggleCrossfade` just toggles a boolean — no actual audio crossfading occurs.
3. **No keyboard shortcuts for desktop**: Previous/Next/Play/Pause via media keys not handled.
4. **Volume setting not persisted**: Volume resets to 0.8 on every page load.
5. **Audio element is a singleton**: Created once via `getAudio()`. If the track changes rapidly, there could be race conditions with `src` assignment vs `play()`.
6. **`showLyrics` triggers fetch on toggle**: When `toggleLyrics` is called, it immediately fetches lyrics for the current track. If lyrics panel is closed and reopened, it refetches (no caching). The `LyricsPanel` component also has its own fetch logic separate from the store — and the `DesktopFullscreenPlayer` has its own local lyrics state completely separate from the store's `lyrics` signal. This means:
   - Player bar lyrics toggle → fetches into store
   - Fullscreen player lyrics tab → fetches into local state
   - They're completely independent and one doesn't update the other.

### 5.11 DesktopFullscreenPlayer

**Issues**:
1. **Duplicate lyrics logic**: As mentioned, this component has its own `localLyrics`/`localLyricsLoading` state and fetches independently from the store.
2. **Track change polling**: Uses `setInterval(checkTrackChange, 500)` to detect track changes. This is inefficient — could use an `onTrackChange` callback or derive from signals.
3. **Escape key listener never removed if component unmounts before mount completes**: Though `onCleanup` is set up in `onMount`, if the component is conditionally rendered and unmounted quickly, the event listener might not be properly registered.
4. **Queue is limited to 30 items in display** (`upNextTracks().slice(0, 30)`).

### 5.12 Login Page

**Issues**:
1. **CAPTCHA refreshes on failed login even for wrong credentials**: The CAPTCHA is refreshed on ANY error, including wrong password. This makes brute-force harder but also annoys legitimate users who mistype.
2. **No "forgot password" flow**: Not implemented.
3. **Registration does not require CAPTCHA**: The register flow has no CAPTCHA protection, while login does. This is inconsistent.

---

## 6. API Gaps Between Frontend and Backend

### Frontend calls non-existent endpoints

| Frontend API Call | Endpoint Hit | Backend Exists? |
|---|---|---|
| `api.getSimilarArtists(artist)` | `GET /api/artists/similar?artist=X` | ❌ NO |
| `api.getArtistPlaylists(artist)` | `GET /api/playlists?artist=X` | ❌ NO (no `artist` query param) |

### Frontend expects fields the backend doesn't return

| Component | Field Expected | Backend Returns |
|---|---|---|
| Home (playlist cards) | `pl.track_count` | Not in `GetPlaylists` response |
| Playlists page | `pl.track_count` | Not in `GetPlaylists` response |
| TrackMenu (playlist picker) | `pl.track_count` | Not in `GetPlaylists` response |
| AlbumDetail | `album()?.year` | No `year` field in Album model |
| Artists (album cards) | `album.name` | Uses `name` JSON tag — ✅ OK |

### Backend has endpoints the frontend doesn't use

| Endpoint | Purpose |
|---|---|
| `PUT /api/playlists/:id` | Update playlist name/description |
| `DELETE /api/history/:id` | Delete history entry |
| `GET /api/settings/crossfade` | Get crossfade setting |
| `POST /api/tracks/sync` | Manual track sync |

---

## 7. UI/UX Issues

### Structural
1. **No queue management page**: Queue can only be seen in the fullscreen player. No way to view/manage the queue separately.
2. **No search in playlists**: Users can't search within a playlist for specific tracks.
3. **No multi-select**: No way to select multiple tracks and bulk-add to playlist or bulk-delete.
4. **No dark/light mode toggle**: Only dark theme exists.
5. **No settings page**: No UI for crossfade toggle, autoplay toggle, account management, or audio quality settings (even though the backend supports crossfade setting).
6. **Mobile navigation doesn't include History**: The MobileNav has no History link (only desktop sidebar does).

### Visual
1. **All styles in one `styles.css` (2640 lines)**: Extremely hard to maintain. No CSS modules or component-scoped styles.
2. **No responsive design system**: The layout uses fixed sidebar width (`220px`) and player height (`80px`). Breakpoints are hardcoded.
3. **No loading skeletons**: Only text "Memuat..." loading states everywhere. No skeleton placeholders.
4. **No animations/transitions**: Track lists, menus, and page transitions appear/disappear instantly.
5. **No error boundaries**: If any component throws, the whole app might crash.

### Accessibility
1. **No aria labels** beyond basic semantic HTML.
2. **Keyboard navigation is limited**: The sidebar links work, but track lists, menus, and player controls are not fully keyboard-accessible.
3. **No focus management**: When menus open/close, focus is not managed.
4. **Color contrast**: The `--text-muted: #666` on `--bg-primary: #0a0a0a` has poor contrast ratio (~5.5:1, borderline for WCAG AA).

---

## 8. Code Quality Issues

### Backend
1. **Inconsistent error handling**: Some handlers use structured `fiber.Map{"error": "..."}`, others might not catch all error cases.
2. **No input validation beyond basic checks**: Track IDs in URLs are parsed with `strconv.Atoi` but no bounds checking.
3. **No rate limiting on API endpoints**: Only login has rate limiting.
4. **Hardcoded admin user**: `SeedDefaultUser("kresna", "zilann123")` in main.go.
5. **JWT secret fallback**: Falls back to `"omnia-music-secret-change-me"` if env var not set. This is a security issue.
6. **Global state in handlers package**: `var AudioPath string`, `var IndexPath string` — mutable global state.
7. **CAPTCHA secret derivation**: `cfg.JWTSecret + "-captcha"` — if JWT secret is compromised, CAPTCHA is also compromised.
8. **No database migrations**: Uses `ALTER TABLE ADD COLUMN` with error-ignoring (`DB.Exec(q)` without checking errors for some queries).
9. **`GetRecommendations` doesn't exclude current track from same-artist/same-genre queries**: It adds `id != ?` for some queries but the initial query for same-artist might still include the current track.
10. **Potential deadlock on concurrent DB writes**: `DB.SetMaxOpenConns(5)` with WAL mode, but no explicit transaction management in handlers.

### Frontend
1. **`any` types everywhere**: The `Track` interface exists but many API responses use `any[]` instead of proper types.
2. **No error boundaries**: No Solid.js ErrorBoundary usage.
3. **Interval/event listener cleanup**: Multiple components have intervals or event listeners without proper cleanup on unmount.
4. **Duplicate menu state logic**: Home page reimplements TrackMenu state instead of using TrackList's built-in menu.
5. **No caching**: Every page re-fetches data on mount. No SWR/React Query equivalent for caching.
6. **Hardcoded API base**: `const BASE = '/api'` in client.ts. No config for different environments.
7. **LocalStorage token**: JWT stored in localStorage (vulnerable to XSS). HttpOnly cookies would be more secure.

---

## 9. Summary of Broken/Incomplete Features

| Feature | Status | Issue |
|---|---|---|
| Similar Artists section | ❌ Broken | API endpoint doesn't exist |
| Artist Playlists section | ❌ Broken | API endpoint doesn't exist |
| "Go to Album" in TrackMenu | ❌ Broken | No-op function |
| Crossfade audio effect | ❌ Not implemented | Boolean toggle only, no audio logic |
| Remove track from playlist | ❌ UI not wired | Backend API exists, but PlaylistDetail doesn't pass remove props |
| Playlist track count display | ❌ Always shows 0 | Backend doesn't return `track_count` |
| Album year display | ❌ Always blank | Backend has no `year` field |
| History delete in UI | ❌ Not implemented | Backend API exists, no UI delete button |
| Edit playlist name/desc | ❌ No UI | Backend PUT exists, no frontend form |
| Queue management page | ❌ Missing | Only visible in fullscreen player |
| Settings page | ❌ Missing | Crossfade toggle in player UI but no dedicated settings page |
| "Top" charts | ⚠️ Misleading | Labels say "Top 100" but tracks are random |
| CAPTCHA on register | ⚠️ Missing | Only login has CAPTCHA |
| Mobile History nav | ❌ Missing | History not in MobileNav |
| Volume persistence | ❌ Missing | Resets every session |
| Lyrics redundancy | ⚠️ Duplicate logic | Store, LyricsPanel, and DesktopFullscreenPlayer all fetch independently |

## 10. Recommended Priority Actions

### Critical (broken features)
1. Implement `GET /api/artists/similar` endpoint OR remove Similar Artists section from Artists.tsx
2. Remove `api.getArtistPlaylists` call or implement the `?artist=` query param in backend `GetPlaylists`
3. Fix TrackMenu's "Ke Album" to actually navigate to the album (needs album name in track data)
4. Wire `removeTrack` function in PlaylistDetail to the TrackList's `showRemoveFromPlaylist`/`onRemoveFromPlaylist` props

### High (missing functionality)
5. Add `track_count` to playlist list endpoint (either via JOIN or a subquery)
6. Add a delete button UI to History page
7. Implement actual crossfade audio logic (fade out/in when track changes)
8. Add "Ke Album" navigation — needs `album` field in the `Track` type and on `TrackMenu`

### Medium (UI/UX improvements)
9. Refactor duplicate menu state — use TrackList's built-in menu on Home page
10. Fix album year display — remove from template or add to backend
11. Add playlist edit UI (name/description)
12. Clean up `setInterval`/`addEventListener` on component unmount
13. Implement proper TypeScript types for all API responses (replace `any`)
14. Add queue management page
15. Add settings page with crossfade toggle

### Low (polish)
16. Merge the two lyrics implementations (store vs local state)
17. Add keyboard shortcuts for player
18. Add responsive CSS improvements
19. Split large styles.css into component files
20. Add loading skeletons instead of text
21. Ensure JWT_SECRET is always set via environment variable
