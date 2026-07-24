# Omnia Music — Task Plan

## Overview
Fix broken features, improve UI/UX consistency, and add missing functionality to the Omnia Music web app.

**Stack**: Go + Fiber (backend) | Solid.js + TypeScript (frontend) | SQLite
**Project root**: `/home/kresna/omnia-music`

---

## PRIORITY 1: Critical Fixes (Must Do)

### 1.1 Fix Artist Page — Remove Broken Sections
**File**: `web/src/pages/Artists.tsx`
- Remove or comment out the "Similar Artists" section (calls non-existent `/api/artists/similar`)
- Remove or comment out the "Playlist" section in artist detail (calls non-existent `/api/playlists?artist=X`)
- Keep: artist tracks, artist albums (these work)

### 1.2 Fix TrackMenu "Go to Album"
**File**: `web/src/components/TrackMenu.tsx`
- The `handleGoToAlbum` function is empty
- Fix: Navigate to `/albums/{album_name}` using the track's `album` field
- The Track type has `album?: string` — use it

### 1.3 Fix Playlist — Wire Remove Track
**File**: `web/src/pages/PlaylistDetail.tsx`
- The `removeTrack` function exists but is never passed to TrackList
- Fix: Pass `showRemoveFromPlaylist={true}` and `onRemoveFromPlaylist={removeTrack}` to TrackList

### 1.4 Fix Playlist Track Count
**File**: `server/handlers/playlists.go`
- `GetPlaylists` doesn't return `track_count`
- Fix: Add a subquery to count tracks per playlist
```sql
SELECT p.id, p.user_id, p.name, p.description, p.created_at, p.updated_at,
       COALESCE((SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id), 0) AS track_count
FROM playlists p WHERE p.user_id = ?
```

---

## PRIORITY 2: Important Functionality

### 2.1 Three-Dot Menu Consistency
**Files**: `web/src/components/TrackMenu.tsx`, `web/src/components/TrackList.tsx`
- Ensure TrackMenu works on ALL pages: Home, Search, Artists, Albums, History, PlaylistDetail
- The menu should show relevant options based on context:
  - Always: Play, Play Next, Add to Playlist
  - If on playlist detail: Remove from Playlist
  - If track has album: Go to Album
  - If track has artist: Go to Artist

### 2.2 Fix Home Page — Remove Duplicate Menu Logic
**File**: `web/src/pages/Home.tsx`
- Home page has its own menu state instead of using TrackList's built-in menu
- Refactor to use TrackList component for all track listings (For You, Recently Played)
- This ensures consistent menu behavior

### 2.3 Add History Delete Button
**File**: `web/src/pages/History.tsx`
- Backend has `DELETE /api/history/:id` but no UI button
- Add a delete button/icon on each history item
- Add confirmation before delete

### 2.4 Add Playlist Edit UI
**File**: `web/src/pages/PlaylistDetail.tsx`
- Backend has `PUT /api/playlists/:id` but no UI
- Add inline edit for playlist name and description
- Add edit icon/button next to playlist name

### 2.5 Fix Album Year Display
**File**: `web/src/pages/AlbumDetail.tsx`
- `album()?.year` is always empty because backend has no `year` field
- Fix: Remove the year display from the template OR remove the field entirely

---

## PRIORITY 3: UI/UX Improvements

### 3.1 Add "Play All" Button to Playlist Detail
**File**: `web/src/pages/PlaylistDetail.tsx`
- Add a prominent "Play All" button at the top of playlist detail
- Should queue all tracks in the playlist

### 3.2 Mobile Navigation — Add History
**File**: `web/src/components/MobileNav.tsx`
- History is missing from mobile bottom nav
- Add it as a nav item

### 3.3 Consistent Track Cards
- Ensure all track listings use the same TrackList component
- Consistent styling, hover effects, and menu behavior

### 3.4 Better Loading States
- Replace "Memuat..." text with simple loading indicators
- Add loading state to playlist cards, artist cards, etc.

### 3.5 Clean Up Intervals/Listeners
**Files**: Multiple
- Fix `setInterval` in Home.tsx (never cleaned up)
- Fix debounce timer in Search.tsx (never cleaned on unmount)
- Fix track change polling in DesktopFullscreenPlayer.tsx

---

## PRIORITY 4: Polish

### 4.1 Volume Persistence
**File**: `web/src/stores/player.ts`
- Save volume to localStorage
- Restore on page load

### 4.2 Merge Lyrics Logic
**Files**: `web/src/stores/player.ts`, `web/src/components/DesktopFullscreenPlayer.tsx`
- Two independent lyrics fetching systems
- Unify to use the store's lyrics signal

### 4.3 Add Queue Track Count
**File**: `web/src/components/DesktopFullscreenPlayer.tsx`
- Show total queue count
- Remove the 30-item limit or add "Show all" button

---

## Files to Modify

### Frontend (Solid.js)
- `web/src/pages/Home.tsx`
- `web/src/pages/Artists.tsx`
- `web/src/pages/PlaylistDetail.tsx`
- `web/src/pages/Playlists.tsx`
- `web/src/pages/History.tsx`
- `web/src/pages/AlbumDetail.tsx`
- `web/src/components/TrackMenu.tsx`
- `web/src/components/TrackList.tsx`
- `web/src/components/MobileNav.tsx`
- `web/src/components/DesktopFullscreenPlayer.tsx`
- `web/src/stores/player.ts`

### Backend (Go)
- `server/handlers/playlists.go` (add track_count)

---

## Constraints
- Do NOT change the database schema
- Do NOT change authentication logic
- Do NOT change audio streaming logic
- Keep existing API endpoints working
- Add new fields to existing endpoints only (like track_count)
- Write clean, maintainable Solid.js code
- Follow existing code patterns and style
