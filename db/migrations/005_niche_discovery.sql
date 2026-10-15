CREATE TABLE niche_searches (
  id BIGSERIAL PRIMARY KEY,
  niche TEXT NOT NULL,
  search_term TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'importing', 'succeeded', 'partial', 'failed')),
  provider_run_id TEXT,
  imported_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE niche_search_reels (
  search_id BIGINT NOT NULL REFERENCES niche_searches(id) ON DELETE CASCADE,
  reel_id BIGINT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  relevance_score INTEGER NOT NULL DEFAULT 0,
  matched_terms JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY (search_id, reel_id)
);

CREATE INDEX niche_search_reels_rank_idx ON niche_search_reels(search_id, relevance_score DESC);
CREATE INDEX niche_searches_started_at_idx ON niche_searches(started_at DESC);
