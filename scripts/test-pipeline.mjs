// Test integrasi jalur playback baru — persis alur bot:
// resolve -> curl bounded-range -> ffmpeg stdin -> demuxProbe -> createAudioResource
import { createAudioResource } from "@discordjs/voice";
import { YTDlpService } from "../src/services/ytdlp.js";
import { GuildPlayer } from "../src/player/GuildPlayer.js";

const svc = new YTDlpService();
const gp = new GuildPlayer({ client: {}, guildId: "test-guild", ytdlp: svc, lyrics: null, audioCache: null });

console.log("== [1] Resolve track ==");
const result = await svc.resolve("sal priadi hai selamat pagi", { bypassCache: true });
const track = result.tracks[0];
console.log("track:", track.title);
if (!track.streamUrl) { console.log("FAIL: no streamUrl"); process.exit(1); }

console.log("\n== [2] Pipeline: createAudioPipeline ==");
const pipeline = await gp.createAudioPipeline(track, false);

// TIDAK ada listener stdout sebelum probe (persis alur bot)
const resource = pipeline.resource;
let resourceBytes = 0;
let last = Date.now();
resource.playStream.on("data", (c) => {
  resourceBytes += c.length;
  if (Date.now() - last > 2000) { console.log("  ...bytes:", resourceBytes); last = Date.now(); }
});
resource.playStream.on("error", (e) => console.log("resource error:", e.message));

await new Promise((r) => setTimeout(r, 6000));
console.log("resourceBytes setelah 6s:", resourceBytes);

console.log("\n== [3] Bersih-bersih ==");
pipeline.process?.kill("SIGKILL");
pipeline.sourceProcess?.kill("SIGKILL");
await new Promise((r) => setTimeout(r, 500));

const passed = resourceBytes > 50000;
console.log("\n=== RESULT:", passed ? "PASS ✅" : "FAIL ❌", "===");
process.exit(passed ? 0 : 1);
