#!/usr/bin/env python3
"""
MusicBrainz Batch Album Lookup Script

Reads index.json from the omnia audio cache, queries MusicBrainz API
to find real album names for each track, and updates the index.

Features:
- Rate-limited to 1 request/second (MusicBrainz policy)
- Resumes from checkpoint if interrupted
- Saves progress every 50 tracks
- Skips tracks that already have a real album (album != artist/uploader)
- Filters out live recordings, bootlegs, and concert recordings
- Graceful error handling for HTTP failures and missing data
"""

import json
import os
import re
import sys
import time
import urllib.parse

import requests

# --- Configuration ---
INDEX_PATH = "/home/kresna/omnia-music/storage/audio-cache/index.json"
CHECKPOINT_PATH = "/home/kresna/omnia-music/storage/audio-cache/.album_lookup_checkpoint.json"
MUSICBRAINZ_API = "https://musicbrainz.org/ws/2/recording/"
USER_AGENT = "OmniaMusic/1.0 (music-library-tool) python-requests/3.11"
BATCH_SAVE_INTERVAL = 50  # Save progress every N tracks
MIN_SECONDS_BETWEEN_REQUESTS = 1.0

# Live recording / bootleg patterns to reject as album names
LIVE_RECORDING_RE = re.compile(
    r'(?i)'
    r'(\d{4}-\d{2}-\d{2}:|'           # date-prefixed concerts: "2016-07-30: SAP Center..."
    r'\blive\s+(at|in|on|from)\b|'     # live at/in venue
    r'\b(tour|festival|concert|world\s+tour)\b|'
    r'\b(amphitheatre|arena|stadium|colosseum|madison\s+square|pyramid\s+stage|grammy\s+museum)\b|'
    r'\b(saturday\s+night\s+live|iheartradio|kroq|bbc\s+radio|paradiso\s+fm|cbc\s+exclusive)\b|'
    r'\b(k\s+bye\s+for\s+now|live\s+rarities|live\s+from|synchronicity\s+concert)\b|'
    r'\b(spotify\s+singles|video\s+collection|the\s+video\s+year\s+mix)\b)'
)


def is_live_recording(album: str) -> bool:
    """Check if an album name looks like a live recording or bootleg."""
    return bool(LIVE_RECORDING_RE.search(album))


def strip_youtube_noise(title: str, artist: str | None = None) -> str:
    """Remove common YouTube video title noise for cleaner MusicBrainz queries.

    If artist is provided, strips the "{artist} - " prefix from the title.
    """
    patterns = [
        r"\s*\(Official Music Video\)\s*",
        r"\s*\(Official Lyric Video\)\s*",
        r"\s*\(Official Lyric & Commentary Video\)\s*",
        r"\s*\(Official Audio\)\s*",
        r"\s*\[Official Music Video\]\s*",
        r"\s*\[OFFICIAL\]\s*",
        r"\s*\(Audio\)\s*",
        r"\s*\(Lyric Video\)\s*",
        r"\s*\(Visualizer\)\s*",
        r"\s*\(Music Video\)\s*",
        r"\s*\(Official Video\)\s*",
        r"\s*\(Video\)\s*",
        r"\s*\(Official\)\s*",
        r"^\s*[-–]\s*",  # leading dash
        r"\s*[-–]\s*$",  # trailing dash
    ]
    cleaned = title

    # If we know the artist, strip "{artist} - " or "{artist} – " prefix
    if artist:
        # Escape regex special chars in artist name
        escaped_artist = re.escape(artist)
        prefix_pattern = rf"^{escaped_artist}\s+[-–]\s+"
        cleaned = re.sub(prefix_pattern, "", cleaned, flags=re.IGNORECASE)

    for pattern in patterns:
        cleaned = re.sub(pattern, "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


def load_index(path: str) -> list:
    """Load the index.json file and return the entries list."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("entries", data if isinstance(data, list) else [])


def save_index(path: str, entries: list):
    """Write entries back to index.json."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"entries": entries}, f, indent=2, ensure_ascii=False)


def load_checkpoint() -> int:
    """Return the index of the last successfully processed track (0-based)."""
    if os.path.exists(CHECKPOINT_PATH):
        with open(CHECKPOINT_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data.get("last_processed_index", -1)
    return -1


def save_checkpoint(index: int):
    """Persist the current processing position."""
    os.makedirs(os.path.dirname(CHECKPOINT_PATH), exist_ok=True)
    with open(CHECKPOINT_PATH, "w", encoding="utf-8") as f:
        json.dump({"last_processed_index": index}, f)


def needs_lookup(track: dict, artist_field: str = "normalizedArtist") -> bool:
    """Check if a track needs a real album lookup.

    Returns True if the album is still a placeholder (same as artist/uploader).
    """
    album = (track.get("album") or "").strip().lower()
    artist = (track.get(artist_field) or track.get("uploader") or "").strip().lower()
    # If album equals artist or uploader, it's a placeholder — needs lookup
    return album == artist or album == (track.get("uploader") or "").strip().lower()


def query_musicbrainz(title: str, artist: str, session: requests.Session) -> str | None:
    """Query MusicBrainz for the album name of a recording.

    Returns the album title (release title) or None if not found.
    Filters out live recordings and bootlegs.
    """
    # Clean the query terms
    clean_title = strip_youtube_noise(title, artist=artist)

    # Build query: https://musicbrainz.org/ws/2/recording/?query=...
    query = f'recording:"{clean_title}" AND artist:"{artist}"'
    params = {"query": query, "fmt": "json", "limit": 5}  # Get multiple results to filter

    headers = {"User-Agent": USER_AGENT}

    resp = None
    try:
        resp = session.get(
            MUSICBRAINZ_API,
            params=params,
            headers=headers,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()

        recordings = data.get("recordings", [])
        if not recordings:
            return None

        # Try each recording's releases, skip live recordings
        for recording in recordings:
            releases = recording.get("releases", [])
            for release in releases:
                album_title = release.get("title", "")
                if album_title and not is_live_recording(album_title):
                    return album_title

        # All releases were live recordings — return None
        return None

    except requests.exceptions.HTTPError as e:
        status = resp.status_code if resp is not None else "unknown"
        if status == 503:
            print(f"  [WARN] 503 Service Unavailable (backing off)")
        else:
            print(f"  [ERROR] HTTP {status}: {e}")
        return None
    except requests.exceptions.RequestException as e:
        print(f"  [ERROR] Request failed: {e}")
        return None
    except (json.JSONDecodeError, KeyError, IndexError) as e:
        print(f"  [ERROR] Parse error: {e}")
        return None


def main():
    print("=" * 60)
    print("MusicBrainz Batch Album Lookup")
    print("=" * 60)

    # Load index
    if not os.path.exists(INDEX_PATH):
        print(f"[FATAL] index.json not found at: {INDEX_PATH}")
        sys.exit(1)

    entries = load_index(INDEX_PATH)
    total = len(entries)
    print(f"Loaded {total} tracks from index.json\n")

    # Load checkpoint to resume
    start_from = load_checkpoint()
    if start_from >= 0:
        print(f"Resuming from checkpoint: track #{start_from + 1} (0-based: {start_from})")
        # Count how many already have real albums (processed previously)
        already_done = sum(
            1 for i, e in enumerate(entries[: start_from + 1])
            if not needs_lookup(e["track"])
        )
        print(f"  ({already_done} already had real albums in first {start_from + 1} tracks)")
    else:
        start_from = 0
        print("Starting fresh lookup\n")

    # Count how many need lookup
    need_lookup_count = sum(1 for e in entries if needs_lookup(e["track"]))
    already_have = total - need_lookup_count
    print(f"Tracks that already have a real album (skipping): {already_have}")
    print(f"Tracks needing lookup: {need_lookup_count}\n")

    session = requests.Session()
    last_request_time = 0.0
    processed = 0
    looked_up = 0
    found = 0
    not_found = 0
    skipped_live = 0
    errors = 0
    stats_saved = False

    for i, entry in enumerate(entries):
        # Track indexing: process from start_from onward
        if i < start_from:
            continue

        track = entry["track"]
        title = track.get("title", "")
        artist = track.get("normalizedArtist") or track.get("uploader") or ""
        current_album = track.get("album", "")

        # Skip if it already has a real album
        if not needs_lookup(track):
            # If existing album is a live recording, clear it
            if current_album and is_live_recording(current_album):
                print(f"  [{i + 1}/{total}] CLEAR LIVE: {artist} - {title[:50]} (was: '{current_album}')")
                track["album"] = ""
                skipped_live += 1
            else:
                print(f"  [{i + 1}/{total}] SKIP: {artist} - {title[:50]} (album: '{current_album}')")
            processed += 1
            # Still save checkpoint to track progress
            if processed % BATCH_SAVE_INTERVAL == 0:
                save_checkpoint(i)
                stats_saved = True
            continue

        # Rate limiting: ensure at least MIN_SECONDS_BETWEEN_REQUESTS since last request
        elapsed = time.time() - last_request_time
        if elapsed < MIN_SECONDS_BETWEEN_REQUESTS:
            time.sleep(MIN_SECONDS_BETWEEN_REQUESTS - elapsed)

        # Query MusicBrainz
        looked_up += 1
        print(f"  [{i + 1}/{total}] QUERY: {artist} - {title[:60]}", end="")
        album_name = query_musicbrainz(title, artist, session)
        last_request_time = time.time()

        if album_name:
            track["album"] = album_name
            found += 1
            print(f" -> FOUND: '{album_name}'")
        else:
            not_found += 1
            print(f" -> NOT FOUND")

        processed += 1

        # Batch save every BATCH_SAVE_INTERVAL tracks
        if processed % BATCH_SAVE_INTERVAL == 0:
            print(f"\n  --- Saving progress ({processed}/{total} processed) ---")
            if album_name is None:
                track["_mb_lookup_attempted"] = True
            save_index(INDEX_PATH, entries)
            save_checkpoint(i)
            stats_saved = True
            print(f"  --- Saved ---\n")

        # Save last checkpoint if we're about to exit
        if (i % BATCH_SAVE_INTERVAL) != 0 and stats_saved:
            stats_saved = False

    # Final save
    print(f"\n  --- Final save ({processed}/{total} processed) ---")
    save_index(INDEX_PATH, entries)
    save_checkpoint(total - 1)
    print(f"  --- Done ---\n")

    # Summary
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Total tracks:          {total}")
    print(f"Already had album:     {already_have}")
    print(f"Queried MusicBrainz:   {looked_up}")
    print(f"  - Album found:       {found}")
    print(f"  - Not found:         {not_found}")
    print(f"  - Errors:            {errors}")
    print(f"Cleared live recordings: {skipped_live}")
    print(f"Checkpoint saved at:   {CHECKPOINT_PATH}")
    print("=" * 60)


if __name__ == "__main__":
    main()
