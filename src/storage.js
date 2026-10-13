import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function extensionFor(contentType, fallback) {
  if (contentType?.includes("mp4")) return "mp4";
  if (contentType?.includes("webm")) return "webm";
  if (contentType?.includes("png")) return "png";
  if (contentType?.includes("webp")) return "webp";
  if (contentType?.includes("jpeg") || contentType?.includes("jpg")) return "jpg";
  return fallback;
}

export function createMediaStorage(env = process.env) {
  const accountId = String(env.R2_ACCOUNT_ID || "").trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || "").trim();
  const bucket = String(env.R2_BUCKET || "").trim();
  const publicBaseUrl = cleanBaseUrl(env.R2_PUBLIC_BASE_URL);
  const configured = Boolean(accountId && accessKeyId && secretAccessKey && bucket && publicBaseUrl);
  const maxBytes = Number(env.MEDIA_MAX_BYTES || 120 * 1024 * 1024);
  const client = configured ? new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey }
  }) : null;

  async function storeRemote({ reelId, kind, sourceUrl }) {
    if (!configured || !sourceUrl) return null;
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`Не удалось скачать ${kind}: ${response.status}`);
    const advertisedLength = Number(response.headers.get("content-length") || 0);
    if (advertisedLength > maxBytes) throw new Error(`${kind} превышает лимит хранения`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`${kind} превышает лимит хранения`);
    const contentType = response.headers.get("content-type")?.split(";")[0] ||
      (kind === "video" ? "video/mp4" : "image/jpeg");
    const extension = extensionFor(contentType, kind === "video" ? "mp4" : "jpg");
    const key = `reels/${reelId}/${kind}.${extension}`;
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable"
    }));
    return {
      provider: "cloudflare-r2",
      key,
      publicUrl: `${publicBaseUrl}/${key}`,
      contentType,
      sizeBytes: bytes.byteLength,
      sourceUrl
    };
  }

  return { configured, storeRemote };
}
