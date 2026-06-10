import test from "node:test";
import assert from "node:assert/strict";
import {
  YoutubeErrorKind,
  createYoutubeError,
  createYoutubeServiceError,
  getYoutubeErrorKind,
} from "../src/services/youtubeErrors.js";

const cases = [
  ["ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader", YoutubeErrorKind.TRACK_UNAVAILABLE],
  ["ERROR: [youtube] abc: The uploader has not made this video available in your country", YoutubeErrorKind.TRACK_UNAVAILABLE],
  ["ERROR: [youtube] abc: This video contains content from Disney, who has blocked it in your country on copyright grounds", YoutubeErrorKind.TRACK_UNAVAILABLE],
  ["ERROR: [youtube] abc: This video is DRM protected", YoutubeErrorKind.TRACK_UNAVAILABLE],
  ["ERROR: [youtube] abc: Sign in to confirm your age", YoutubeErrorKind.TRACK_UNAVAILABLE],
  ["ERROR: [youtube] abc: Requested format is not available", YoutubeErrorKind.TRACK_UNAVAILABLE],
  ["ERROR: Unsupported URL: https://youtube.com/not-a-video", YoutubeErrorKind.TRACK_UNAVAILABLE],
  ["ERROR: Server returned 404 Not Found", YoutubeErrorKind.TRACK_UNAVAILABLE],
  ["ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser", YoutubeErrorKind.SERVICE_UNAVAILABLE],
  ["ERROR: PO Token Provider returned no token", YoutubeErrorKind.SERVICE_UNAVAILABLE],
  ["ERROR: failed to load cookies from /app/config/cookies.txt", YoutubeErrorKind.SERVICE_UNAVAILABLE],
  ["ERROR: [youtube] abc: nsig extraction failed", YoutubeErrorKind.SERVICE_UNAVAILABLE],
  ["ERROR: Server returned 403 Forbidden from googlevideo.com", YoutubeErrorKind.SERVICE_UNAVAILABLE],
  ["WARNING: No supported JavaScript runtime. ERROR: Requested format is not available", YoutubeErrorKind.SERVICE_UNAVAILABLE],
  ["ffmpeg exited with code 1: Unknown encoder libopus", YoutubeErrorKind.UNKNOWN],
  ["yt-dlp hydrate failed: unknown error", YoutubeErrorKind.UNKNOWN],
];

for (const [message, expected] of cases) {
  test(`classifies ${expected}: ${message}`, () => {
    assert.equal(getYoutubeErrorKind(new Error(message)), expected);
  });
}

test("wrapped yt-dlp errors retain their classification", () => {
  const source = Object.assign(new Error("command failed"), {
    stderr: "ERROR: This video is unavailable",
  });
  const wrapped = createYoutubeError(source, "hydrate");

  assert.equal(wrapped.youtubeErrorKind, YoutubeErrorKind.TRACK_UNAVAILABLE);
  assert.match(wrapped.message, /yt-dlp hydrate failed/);
});

test("offline guard creates an explicit service error", () => {
  const error = createYoutubeServiceError(
    "YouTube sedang error, playback dibatasi ke lagu cache lokal.",
  );

  assert.equal(getYoutubeErrorKind(error), YoutubeErrorKind.SERVICE_UNAVAILABLE);
});
