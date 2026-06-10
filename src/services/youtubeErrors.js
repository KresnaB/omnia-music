export const YoutubeErrorKind = Object.freeze({
  TRACK_UNAVAILABLE: "track_unavailable",
  SERVICE_UNAVAILABLE: "service_unavailable",
  UNKNOWN: "unknown",
});

function collectErrorText(error) {
  const parts = [];
  const visited = new Set();
  let current = error;

  while (current && !visited.has(current)) {
    visited.add(current);
    parts.push(current.code, current.name, current.message, current.stdout, current.stderr);
    current = current.cause;
  }

  return parts
    .filter(Boolean)
    .join(" ")
    .normalize("NFKD")
    .replace(/[\u2018\u2019]/g, "'")
    .toLowerCase();
}

const TRACK_UNAVAILABLE_PATTERN =
  /video (?:is )?unavailable|this (?:video|content) (?:isn't|is not) available|has been removed|removed by (?:the )?uploader|account associated with this video has been terminated|private video|not available in your (?:country|location)|uploader has not made .* available|geo(?:graphically)?[ -]?restricted|copyright grounds|blocked .* copyright|age[ -]?restricted|confirm your age|members?[ -]?only|join this channel|requires payment|paid content|premium[ -]?only|music premium|drm[ -]?protected|not available on this app|unsupported url|invalid (?:youtube )?(?:url|video id)|incomplete youtube id|premiere|live event will begin|scheduled to (?:begin|start)/;

const SERVICE_UNAVAILABLE_PATTERN =
  /po[ -]?token|pot provider|proof of origin|bgutil|cookies? (?:are |have )?(?:expired|invalid|corrupt|no longer valid)|cookies?.*(?:rotated|need to be refreshed)|refresh your cookies|failed to (?:load|parse|read|copy|decrypt) cookies?|cookie (?:file|database).*(?:missing|not found|does not exist|failed|error)|sign in to confirm (?:that )?you're not a bot|use --cookies(?:-from-browser)?|unable to extract|failed to extract|player response|nsig extraction|signature extraction|no supported javascript runtime|javascript runtime.*(?:missing|not found)|innertube|extractor.*(?:broken|failed)|only images are available|http error 40[13]|status code 40[13]|server returned 40[13]|too many requests|http error 429|status code 429|server returned 429|econnreset|etimedout|eai_again|enotfound|getaddrinfo|name resolution|network is unreachable/;

const TRACK_FORMAT_PATTERN =
  /requested format is not available|no video formats found|http error 404|status code 404|server returned 404/;

export function getYoutubeErrorKind(error) {
  if (Object.values(YoutubeErrorKind).includes(error?.youtubeErrorKind)) {
    return error.youtubeErrorKind;
  }

  const text = collectErrorText(error);
  // Concrete restrictions belong to the track. Infrastructure clues take
  // priority over generic format/404 failures, which can have either cause.
  if (TRACK_UNAVAILABLE_PATTERN.test(text)) {
    return YoutubeErrorKind.TRACK_UNAVAILABLE;
  }
  if (SERVICE_UNAVAILABLE_PATTERN.test(text)) {
    return YoutubeErrorKind.SERVICE_UNAVAILABLE;
  }
  if (TRACK_FORMAT_PATTERN.test(text)) {
    return YoutubeErrorKind.TRACK_UNAVAILABLE;
  }
  return YoutubeErrorKind.UNKNOWN;
}

export function isYoutubeTrackUnavailableError(error) {
  return getYoutubeErrorKind(error) === YoutubeErrorKind.TRACK_UNAVAILABLE;
}

export function isYoutubeServiceUnavailableError(error) {
  return getYoutubeErrorKind(error) === YoutubeErrorKind.SERVICE_UNAVAILABLE;
}

export function createYoutubeError(error, operation) {
  const detail = `${error?.stdout || ""}\n${error?.stderr || ""}`.trim() || error?.message || "unknown error";
  const wrapped = new Error(`yt-dlp ${operation} failed: ${detail.slice(0, 1000)}`, {
    cause: error,
  });
  wrapped.name = "YoutubeError";
  wrapped.youtubeErrorKind = getYoutubeErrorKind(error);
  wrapped.stdout = error?.stdout || "";
  wrapped.stderr = error?.stderr || "";
  return wrapped;
}

export function createYoutubeServiceError(message, options = {}) {
  const error = new Error(message, options);
  error.name = "YoutubeError";
  error.youtubeErrorKind = YoutubeErrorKind.SERVICE_UNAVAILABLE;
  return error;
}
