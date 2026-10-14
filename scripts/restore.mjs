import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readSecret } from "./secret-input.mjs";

const backupDirectory = process.argv[2] ? path.resolve(process.argv[2]) : null;
const baseUrl = new URL(process.argv[3] || "http://127.0.0.1:3000/");

if (!backupDirectory) {
  process.stderr.write("Использование: npm run restore -- <папка-копии> [адрес-сервера]\n");
  process.exitCode = 1;
} else {
  {
    const status = await fetch(new URL("/api/auth/status", baseUrl));
    if (!status.ok) throw new Error(`Сервер недоступен: ${status.status}`);
    const auth = (await status.json()).data;
    let cookie = "";
    if (auth.enabled) {
      const password = await readSecret("Пароль владельца: ");
      const login = await fetch(new URL("/api/auth/login", baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });
      if (!login.ok) throw new Error((await login.json().catch(() => ({}))).error || "Не удалось войти");
      cookie = login.headers.get("set-cookie")?.split(";")[0] || "";
    }
    const backup = JSON.parse(await readFile(path.join(backupDirectory, "backup.json"), "utf8"));
    const restored = await fetch(new URL("/api/admin/restore", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/vnd.reels-finder.backup+json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(backup)
    });
    if (!restored.ok) throw new Error((await restored.json().catch(() => ({}))).error || `Восстановление не удалось: ${restored.status}`);
    const result = (await restored.json()).data;
    process.stdout.write(`Данные восстановлены: ${result.reels} рилсов, ${result.scripts} сценариев\n`);
    for (const [index, media] of (backup.media_files || []).entries()) {
      const reelId = result.reelIds[String(media.reel_id)];
      if (!reelId) continue;
      const content = await readFile(path.join(backupDirectory, media.file));
      const uploaded = await fetch(new URL(`/api/admin/media/${reelId}/${media.kind}`, baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": media.content_type || "application/octet-stream",
          "X-Source-Url": String(media.source_url || "").slice(0, 4000),
          ...(cookie ? { Cookie: cookie } : {})
        },
        body: content
      });
      if (!uploaded.ok) throw new Error(`Не удалось восстановить ${media.file}: ${uploaded.status}`);
      process.stdout.write(`[${index + 1}/${backup.media_files.length}] ${media.file}\n`);
    }
    process.stdout.write("Восстановление завершено.\n");
  }
}
