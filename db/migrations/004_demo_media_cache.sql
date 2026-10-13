ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS content BYTEA;

-- Keep saved scripts, but remove prototype Reel cards whose Instagram URLs
-- were deliberately fictitious and could never open.
DELETE FROM reels WHERE platform_reel_id LIKE 'demo-%';
DELETE FROM competitors
WHERE instagram_handle = '@alyona.health'
  AND NOT EXISTS (SELECT 1 FROM reels WHERE reels.competitor_id = competitors.id);

-- Some Instagram datasets expose plays instead of views. For the demo UI
-- they represent the useful reach metric and should not be displayed as zero.
UPDATE reels
SET views_count = play_count, updated_at = NOW()
WHERE views_count = 0 AND play_count > 0;
