ALTER TABLE sync_runs DROP CONSTRAINT IF EXISTS sync_runs_status_check;
ALTER TABLE sync_runs ADD CONSTRAINT sync_runs_status_check
  CHECK (status IN ('queued', 'running', 'importing', 'succeeded', 'partial', 'failed'));

ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS provider_dataset_id TEXT;
ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0);
ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS media_stored_count INTEGER NOT NULL DEFAULT 0 CHECK (media_stored_count >= 0);

ALTER TABLE reels ADD COLUMN IF NOT EXISTS owner_username TEXT NOT NULL DEFAULT '';
ALTER TABLE reels ADD COLUMN IF NOT EXISTS owner_full_name TEXT NOT NULL DEFAULT '';
ALTER TABLE reels ADD COLUMN IF NOT EXISTS transcript TEXT NOT NULL DEFAULT '';
ALTER TABLE reels ADD COLUMN IF NOT EXISTS hashtags JSONB NOT NULL DEFAULT '[]'::JSONB;
ALTER TABLE reels ADD COLUMN IF NOT EXISTS mentions JSONB NOT NULL DEFAULT '[]'::JSONB;
ALTER TABLE reels ADD COLUMN IF NOT EXISTS audio JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE reels ADD COLUMN IF NOT EXISTS play_count BIGINT NOT NULL DEFAULT 0 CHECK (play_count >= 0);
ALTER TABLE reels ADD COLUMN IF NOT EXISTS media_status TEXT NOT NULL DEFAULT 'external'
  CHECK (media_status IN ('missing', 'external', 'storing', 'stored', 'failed'));
ALTER TABLE reels ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS media_assets (
  id BIGSERIAL PRIMARY KEY,
  reel_id BIGINT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('video', 'thumbnail')),
  storage_provider TEXT NOT NULL,
  storage_key TEXT,
  public_url TEXT NOT NULL,
  source_url TEXT,
  content_type TEXT,
  size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (reel_id, kind)
);

CREATE TABLE IF NOT EXISTS reel_metric_snapshots (
  id BIGSERIAL PRIMARY KEY,
  reel_id BIGINT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  views_count BIGINT NOT NULL DEFAULT 0 CHECK (views_count >= 0),
  play_count BIGINT NOT NULL DEFAULT 0 CHECK (play_count >= 0),
  likes_count BIGINT NOT NULL DEFAULT 0 CHECK (likes_count >= 0),
  comments_count BIGINT NOT NULL DEFAULT 0 CHECK (comments_count >= 0),
  shares_count BIGINT NOT NULL DEFAULT 0 CHECK (shares_count >= 0),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS metric_snapshots_reel_time_idx
  ON reel_metric_snapshots(reel_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS sync_runs_competitor_time_idx
  ON sync_runs(competitor_id, started_at DESC);

-- The first prototype used the same sample video for every card. Keep the
-- sample metadata, but stop presenting that file as if it were the real Reel.
UPDATE reels
SET video_url = NULL, media_status = 'missing', updated_at = NOW()
WHERE platform_reel_id LIKE 'demo-%'
  AND video_url = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
