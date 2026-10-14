import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { readSecret } from "./secret-input.mjs";

const baseUrl = new URL(process.argv[2] || "https://reels-finder.onrender.com/");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
const backupDirectory = path.join(root, "backups", stamp);
const mediaDirectory = path.join(backupDirectory, "media");
const maxAssetBytes = 200 * 1024 * 1024;

function absoluteUrl(value) {
  return new URL(value, baseUrl).toString();
}

function extension(contentType, url, kind) {
  const map = { "video/mp4": "mp4", "video/webm": "webm", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  if (map[contentType]) return map[contentType];
  const match = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
  return match?.[1] || (kind === "video" ? "mp4" : "jpg");
}

async function authenticate() {
  const status = await fetch(absoluteUrl("/api/auth/status"));
  if (!status.ok) throw new Error(`Сервер недоступен: ${status.status}`);
  const auth = (await status.json()).data;
  if (!auth.enabled) return "";
  const password = await readSecret("Пароль владельца: ");
  const login = await fetch(absoluteUrl("/api/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  if (!login.ok) throw new Error((await login.json().catch(() => ({}))).error || "Не удалось войти");
  return login.headers.get("set-cookie")?.split(";")[0] || "";
}

async function download(url, destination) {
  const response = await fetch(absoluteUrl(url), { headers: { "User-Agent": "Mozilla/5.0 ReelsFinderBackup/1.0" } });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const advertised = Number(response.headers.get("content-length") || 0);
  if (advertised > maxAssetBytes) throw new Error("файл больше 200 МБ");
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(received > maxAssetBytes ? new Error("файл больше 200 МБ") : null, chunk);
    }
  });
  const temporary = `${destination}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(temporary));
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { bytes: received, contentType: response.headers.get("content-type")?.split(";")[0] || "application/octet-stream" };
}

{
  const cookie = await authenticate();
  const response = await fetch(absoluteUrl("/api/admin/backup"), { headers: cookie ? { Cookie: cookie } : {} });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Резервная копия недоступна: ${response.status}`);
  const backup = await response.json();
  backup.source = baseUrl.origin;
  backup.media_files = [];
  backup.media_failures = [];
  await mkdir(mediaDirectory, { recursive: true });
  const assets = new Map((backup.data.media_assets || []).map((asset) => [`${asset.reel_id}:${asset.kind}`, asset]));
  const candidates = [];
  for (const reel of backup.data.reels || []) {
    if (reel.video_url) candidates.push({ reel, kind: "video", url: reel.video_url });
    if (reel.thumbnail_url) candidates.push({ reel, kind: "thumbnail", url: reel.thumbnail_url });
  }
  for (const [index, candidate] of candidates.entries()) {
    const asset = assets.get(`${candidate.reel.id}:${candidate.kind}`);
    try {
      const probe = await fetch(absoluteUrl(candidate.url), { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0 ReelsFinderBackup/1.0" } });
      const contentType = probe.headers.get("content-type")?.split(";")[0] || "";
      const file = `${candidate.reel.id}-${candidate.kind}.${extension(contentType, absoluteUrl(candidate.url), candidate.kind)}`;
      const saved = await download(candidate.url, path.join(mediaDirectory, file));
      backup.media_files.push({
        reel_id: candidate.reel.id,
        kind: candidate.kind,
        file: `media/${file}`,
        content_type: saved.contentType,
        size_bytes: saved.bytes,
        source_url: asset?.source_url || absoluteUrl(candidate.url)
      });
      process.stdout.write(`[${index + 1}/${candidates.length}] ${candidate.kind} #${candidate.reel.id}: сохранено\n`);
    } catch (error) {
      backup.media_failures.push({ reel_id: candidate.reel.id, kind: candidate.kind, error: error.message });
      process.stdout.write(`[${index + 1}/${candidates.length}] ${candidate.kind} #${candidate.reel.id}: ${error.message}\n`);
    }
  }
  await writeFile(path.join(backupDirectory, "backup.json"), JSON.stringify(backup, null, 2), "utf8");
  process.stdout.write(`\nРезервная копия: ${backupDirectory}\n`);
  process.stdout.write(`Медиа: ${backup.media_files.length}, ошибок: ${backup.media_failures.length}\n`);
}
