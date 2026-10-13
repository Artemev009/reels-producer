function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function text(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

export function normalizeApifyReel(item, competitorId) {
  const sourceUrl = text(item.url, item.inputUrl, item.postUrl);
  const platformId = text(item.id, item.shortCode, item.code) || sourceUrl;
  if (!platformId || !sourceUrl) return null;

  const description = text(item.caption, item.description, item.text);
  return {
    competitorId,
    platformId,
    sourceUrl,
    videoUrl: text(item.videoUrl, item.video_url, item.videoPlayUrl) || null,
    thumbnailUrl: text(item.displayUrl, item.thumbnailUrl, item.thumbnail_url, item.imageUrl),
    title: text(item.title, description.split("\n")[0], "Instagram Reel").slice(0, 240),
    description,
    durationSeconds: number(item.videoDuration ?? item.duration),
    viewsCount: number(item.videoViewCount ?? item.viewCount ?? item.viewsCount),
    likesCount: number(item.likesCount ?? item.likes),
    commentsCount: number(item.commentsCount ?? item.comments),
    publishedAt: item.timestamp || item.publishedAt || null
  };
}

export async function importFromApify(db, competitor) {
  const token = process.env.APIFY_API_TOKEN;
  const actorId = process.env.APIFY_ACTOR_ID;
  if (!token || !actorId) {
    const error = new Error("Apify ещё не подключён: добавьте APIFY_API_TOKEN и APIFY_ACTOR_ID в Render.");
    error.statusCode = 503;
    throw error;
  }

  const runRecord = await db.query(
    "INSERT INTO sync_runs(competitor_id, status) VALUES ($1, 'running') RETURNING *",
    [competitor.id]
  );
  const syncRun = runRecord.rows[0];

  try {
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const safeActorId = encodeURIComponent(actorId.replace("/", "~"));
    const startedResponse = await fetch(`https://api.apify.com/v2/acts/${safeActorId}/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        username: [competitor.profile_url],
        resultsLimit: 20,
        includeDownloadedVideo: false,
        includeTranscript: false,
        includeSharesCount: false
      })
    });
    if (!startedResponse.ok) throw new Error(`Apify отклонил запуск: ${startedResponse.status}`);
    let run = (await startedResponse.json()).data;

    for (let attempt = 0; !["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status) && attempt < 90; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const runResponse = await fetch(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(run.id)}`, { headers });
      if (!runResponse.ok) throw new Error(`Не удалось получить статус Apify: ${runResponse.status}`);
      run = (await runResponse.json()).data;
    }
    if (run.status !== "SUCCEEDED") throw new Error(`Запуск Apify завершён со статусом ${run.status}`);

    const datasetResponse = await fetch(`https://api.apify.com/v2/datasets/${encodeURIComponent(run.defaultDatasetId)}/items?clean=true&limit=20`, { headers });
    if (!datasetResponse.ok) throw new Error(`Не удалось получить Dataset Apify: ${datasetResponse.status}`);
    const items = await datasetResponse.json();
    let importedCount = 0;

    for (const item of items) {
      const reel = normalizeApifyReel(item, competitor.id);
      if (!reel || !reel.thumbnailUrl) continue;
      await db.query(
        `INSERT INTO reels (
          competitor_id, platform_reel_id, source_url, video_url, thumbnail_url, title,
          description, duration_seconds, views_count, likes_count, comments_count, published_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (platform_reel_id) DO UPDATE SET
          source_url = EXCLUDED.source_url,
          video_url = EXCLUDED.video_url,
          thumbnail_url = EXCLUDED.thumbnail_url,
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          duration_seconds = EXCLUDED.duration_seconds,
          views_count = EXCLUDED.views_count,
          likes_count = EXCLUDED.likes_count,
          comments_count = EXCLUDED.comments_count,
          published_at = EXCLUDED.published_at,
          updated_at = NOW()`,
        [reel.competitorId, reel.platformId, reel.sourceUrl, reel.videoUrl, reel.thumbnailUrl, reel.title,
          reel.description, reel.durationSeconds, reel.viewsCount, reel.likesCount, reel.commentsCount, reel.publishedAt]
      );
      importedCount += 1;
    }

    await db.query("UPDATE competitors SET last_synced_at = NOW(), updated_at = NOW() WHERE id = $1", [competitor.id]);
    await db.query(
      "UPDATE sync_runs SET provider_run_id = $1, status = 'succeeded', imported_count = $2, finished_at = NOW() WHERE id = $3",
      [run.id, importedCount, syncRun.id]
    );
    return { runId: run.id, importedCount };
  } catch (error) {
    await db.query(
      "UPDATE sync_runs SET status = 'failed', error_message = $1, finished_at = NOW() WHERE id = $2",
      [String(error.message).slice(0, 1000), syncRun.id]
    );
    throw error;
  }
}
