CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS competitors (
  id BIGSERIAL PRIMARY KEY,
  instagram_handle TEXT NOT NULL UNIQUE,
  profile_url TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  bio TEXT NOT NULL DEFAULT '',
  follower_count BIGINT NOT NULL DEFAULT 0 CHECK (follower_count >= 0),
  following_count BIGINT NOT NULL DEFAULT 0 CHECK (following_count >= 0),
  posts_count BIGINT NOT NULL DEFAULT 0 CHECK (posts_count >= 0),
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reels (
  id BIGSERIAL PRIMARY KEY,
  competitor_id BIGINT REFERENCES competitors(id) ON DELETE CASCADE,
  platform_reel_id TEXT NOT NULL UNIQUE,
  source_url TEXT NOT NULL,
  video_url TEXT,
  thumbnail_url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  hook_text TEXT NOT NULL DEFAULT '',
  script_text TEXT NOT NULL DEFAULT '',
  cta_text TEXT NOT NULL DEFAULT '',
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  views_count BIGINT NOT NULL DEFAULT 0 CHECK (views_count >= 0),
  likes_count BIGINT NOT NULL DEFAULT 0 CHECK (likes_count >= 0),
  comments_count BIGINT NOT NULL DEFAULT 0 CHECK (comments_count >= 0),
  shares_count BIGINT NOT NULL DEFAULT 0 CHECK (shares_count >= 0),
  is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('new', 'processing', 'ready', 'failed')),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reels_competitor_idx ON reels(competitor_id);
CREATE INDEX IF NOT EXISTS reels_published_idx ON reels(published_at DESC);
CREATE INDEX IF NOT EXISTS reels_favorite_idx ON reels(is_favorite) WHERE is_favorite = TRUE;

CREATE TABLE IF NOT EXISTS scripts (
  id BIGSERIAL PRIMARY KEY,
  reel_id BIGINT REFERENCES reels(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  hook_text TEXT NOT NULL DEFAULT '',
  script_text TEXT NOT NULL DEFAULT '',
  cta_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'published')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tags (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS reel_tags (
  reel_id BIGINT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (reel_id, tag_id)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id BIGSERIAL PRIMARY KEY,
  competitor_id BIGINT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'apify',
  provider_run_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  imported_count INTEGER NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
