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

console.log("\n== [2] Pipeline asli: spawnChunkedSource -> spawnAudioProcess (stdin) ==");
const source = gp.spawnChunkedSource(track.streamUrl);
const ps = gp.spawnAudioProcess(track, "opus", "stdin", source, false);

// TIDAK ada listener stdout sebelum probe (persis alur bot)
const probeResult = await Promise.race([
  ps.probe.then((p) => ({ ok: true, type: p.type, stream: p.stream }), (e) => ({ ok: false, err: e.message })),
  new Promise((r) => setTimeout(() => r({ ok: "timeout" }), 30000)),
]);
console.log("probe:", JSON.stringify({ ok: probeResult.ok, type: probeResult.type }));

if (!probeResult.ok || !probeResult.stream) {
  console.log("FAIL: probe gagal:", probeResult.err);
  ps.process.kill("SIGKILL"); source.kill("SIGKILL");
  process.exit(1);
}

// Konsumsi persis seperti AudioPlayer: createAudioResource -> playStream
const resource = createAudioResource(probeResult.stream, {
  inputType: probeResult.type,
  metadata: track,
});
let resourceBytes = 0;
let last = Date.now();
resource.playStream.on("data", (c) => {
  resourceBytes += c.length;
  if (Date.now() - last > 2000) { console.log("  ...bytes:", resourceBytes); last = Date.now(); }
});
resource.playStream.on("error", (e) => console.log("resource error:", e.message));

await new Promise((r) => setTimeout(r, 12000));
console.log("resourceBytes setelah 12s:", resourceBytes);

console.log("\n== [3] Bersih-bersih ==");
ps.process.kill("SIGKILL");
source.kill("SIGKILL");
await new Promise((r) => setTimeout(r, 500));

const passed = probeResult.ok && resourceBytes > 500000;
console.log("\n=== RESULT:", passed ? "PASS ✅" : "FAIL ❌", "===");
process.exit(passed ? 0 : 1);
