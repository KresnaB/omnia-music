#!/usr/bin/env python3
"""
Backfill album field in index.json entries.
Extracts real artist from title and uses it as album grouping.
"""
import json
import re
from pathlib import Path

INDEX_PATH = Path("/home/kresna/omnia-music/storage/audio-cache/index.json")

# Label patterns (same as Go code)
LABEL_PATTERNS = [
    "musica studios", "sony music", "trinity optima", "hits records",
    "nagaswara", "emotion entertainment", "gp records", "1thek",
    "20th century", "warner records", "universal music", "atlantic records",
    "republic records", "interscope", "columbia records", "rca records",
    "def jam", "capitol records", "virgin records", "parlophone",
    "official video", "official channel", "records", "entertainment",
    "production", "music channel", "vevo",
    "7clouds", "1106 radio", "as tone", "no copyrightsounds",
    "aquarius musikindo", "nagaswara official", "aini musik",
    "musik proaktif", "indolirik", "latin hype", "sonymusicidvevo",
    "dan music", "510 music",
]

def is_label(uploader: str) -> bool:
    lower = uploader.lower()
    return any(label in lower for label in LABEL_PATTERNS)

def normalize_artist(title: str, uploader: str) -> str:
    """Extract real artist from title when uploader is a label."""
    if not is_label(uploader):
        return uploader

    # Try "Artist - Song" pattern
    idx = title.find(" - ")
    if 0 < idx < 50:
        artist = title[:idx].strip()
        if 1 < len(artist) < 60:
            return artist

    # Try "Artist : Song" pattern
    idx = title.find(" : ")
    if 0 < idx < 50:
        artist = title[:idx].strip()
        if 1 < len(artist) < 60:
            return artist

    # Try "[Artist] Song" pattern
    if title.startswith("["):
        end = title.find("]")
        if 0 < end < 50:
            return title[1:end].strip()

    # Try "Song by Artist" pattern
    lower_title = title.lower()
    idx = lower_title.rfind(" by ")
    if idx > 0:
        artist = title[idx+4:].strip()
        if 1 < len(artist) < 60:
            return artist

    # Fallback: use uploader
    return uploader

def main():
    with open(INDEX_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    entries = data.get("entries", [])
    updated = 0
    skipped = 0

    for entry in entries:
        track = entry.get("track", {})
        title = track.get("title", "")
        uploader = track.get("uploader", "")

        # If album already exists and is non-empty, skip
        if track.get("album"):
            skipped += 1
            continue

        # Extract real artist and use as album
        artist = normalize_artist(title, uploader)
        track["album"] = artist
        updated += 1

    print(f"Total entries: {len(entries)}")
    print(f"Updated: {updated}")
    print(f"Skipped (already had album): {skipped}")

    # Save
    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"Saved to {INDEX_PATH}")

    # Stats
    albums = set()
    for entry in entries:
        album = entry.get("track", {}).get("album", "")
        if album:
            albums.add(album)
    print(f"Unique albums: {len(albums)}")

if __name__ == "__main__":
    main()
