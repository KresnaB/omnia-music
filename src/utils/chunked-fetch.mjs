// Fetch stream URL dalam chunk range terbatas berurutan -> stdout.
//
// LATAR BELAKANG: CDN googlevideo (YouTube) menolak request Range tanpa batas,
// full-file, atau >= ~1MB dengan HTTP 403 (anti-ripping enforcement, baru
// dirilis). Request range parsial kecil (< 500KB) SELALU diterima (206).
// Skrip ini mengambil file dalam chunk 400KB yang saling bersambungan
// sehingga hasil gabungannya = file utuh, tapi setiap request tetap "parsial".
import { spawn } from "node:child_process";

const CHUNK_SIZE = 409600; // 400KB — di bawah ambang penolakan CDN
const MAX_RETRIES = 3;

const url = process.argv[2];
if (!url) {
  console.error("usage: chunked-fetch.mjs <stream-url>");
  process.exit(2);
}

// Tangani EPIPE jika proses hilir (ffmpeg) dimatikan (misal saat skip lagu)
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") {
    process.exit(0);
  }
});

function fetchRange(start, end, attempt = 0) {
  return new Promise((resolve, reject) => {
    const curl = spawn(
      "curl",
      [
        "-sS",
        "-f",
        "-L",
        "--retry",
        "2",
        "--retry-delay",
        "1",
        "-r",
        `${start}-${end}`,
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let received = 0;
    let stderr = "";
    curl.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    curl.stdout.on("data", (c) => {
      received += c.length;
    });
    curl.stdout.on("error", () => {});
    // PENTING: { end: false } agar process.stdout TIDAK ditutup saat proses curl satu chunk selesai
    curl.stdout.pipe(process.stdout, { end: false });
    curl.once("error", reject);
    curl.once("close", async (code) => {
      if (code === 0) {
        resolve(received);
        return;
      }
      // 416 = range di luar akhir file -> normal EOF
      if (stderr.includes("416") || (code === 22 && stderr.includes("416"))) {
        resolve(0);
        return;
      }
      // Retry sisa chunk jika gagal di tengah jalan
      if (attempt < MAX_RETRIES) {
        const nextStart = start + received;
        if (nextStart > end) {
          resolve(received);
          return;
        }
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        try {
          const rest = await fetchRange(nextStart, end, attempt + 1);
          resolve(received + rest);
          return;
        } catch (retryError) {
          reject(retryError);
          return;
        }
      }
      reject(
        new Error(
          `chunk ${start}-${end} gagal (code ${code}): ${stderr.slice(0, 200)}`,
        ),
      );
    });
  });
}

async function main() {
  let start = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const end = start + CHUNK_SIZE - 1;
    const received = await fetchRange(start, end);
    if (received < CHUNK_SIZE) {
      break; // server tidak punya byte lagi (akhir file)
    }
    start = end + 1;
  }
  process.stdout.end();
  process.exit(0);
}

main().catch((error) => {
  console.error(`[chunked-fetch] ${error.message}`);
  process.exit(1);
});
