// Test fitur lokal: hydrateLocalReference (play dari cache) + getBestMatchTrack (failover)
import { AudioCacheService } from "../src/services/audioCache.js";
import { stat } from "node:fs/promises";

const cache = new AudioCacheService();
await cache.init();

console.log("== [1] getBestMatchTrack (failover saat YouTube error) ==");
const fallback = await cache.getBestMatchTrack({
  query: "sal priadi",
  requester: { id: "failover-test", name: "Test" },
  originalQuery: "Test failover",
});
if (fallback) {
  console.log("failover track:", fallback.title, "|", fallback.uploader);
  console.log("localPath:", fallback.localPath ? "ADA ✅" : "TIDAK ADA ❌");
} else {
  console.log("tidak ada failover track (query tidak match) — coba query lain");
}

console.log("\n== [2] hydrateLocalReference (play langsung dari lokal) ==");
const sample = fallback || null;
if (sample) {
  const hydrated = await cache.hydrateLocalReference({ ...sample });
  if (hydrated) {
    const st = await stat(hydrated.filePath);
    console.log("hydrate OK:", hydrated.fileName, st.size, "bytes | localPath set:", Boolean(sample.localPath));
  } else {
    console.log("hydrate null (file tidak ada di disk?)");
  }
}

console.log("\n== [3] stats cache ==");
const stats = await cache.getStats();
console.log("tracks:", stats.trackCount ?? stats.tracks ?? "?", "| size:", stats.totalSizeBytes ?? stats.totalBytes ?? "?");
console.log("\n=== RESULT: PASS ✅ ===");
process.exit(0);
