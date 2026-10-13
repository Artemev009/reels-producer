INSERT INTO competitors (instagram_handle, profile_url, display_name, avatar_url, bio, follower_count, following_count, posts_count, last_synced_at)
VALUES (
  '@alyona.health',
  'https://www.instagram.com/alyona.health',
  'Алёна | Здоровье и баланс',
  'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=300&q=85',
  'Здоровые привычки без крайностей',
  320000, 412, 248, NOW()
)
ON CONFLICT (instagram_handle) DO NOTHING;

INSERT INTO reels (
  competitor_id, platform_reel_id, source_url, video_url, thumbnail_url, title, description,
  hook_text, script_text, cta_text, duration_seconds, views_count, likes_count, comments_count,
  shares_count, is_favorite, published_at
)
SELECT c.id, seed.platform_reel_id, seed.source_url, seed.video_url, seed.thumbnail_url, seed.title,
  seed.description, seed.hook_text, seed.script_text, seed.cta_text, seed.duration_seconds,
  seed.views_count, seed.likes_count, seed.comments_count, seed.shares_count, seed.is_favorite,
  NOW() - (seed.age_days || ' days')::INTERVAL
FROM competitors c
CROSS JOIN (VALUES
  ('demo-001', 'https://www.instagram.com/reel/demo-001', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=700&q=85', '3 ошибки в утренней рутине, которые крадут твою энергию', 'Разбор привычек, которые мешают начинать день бодро.', 'Ты тоже просыпаешься уставшим?', '1. Не бери телефон сразу после пробуждения.\n2. Выпей стакан воды.\n3. Подготовь сбалансированный завтрак.', 'Сохрани видео и попробуй завтра утром ❤️', 32, 1200000, 4200, 318, 97, TRUE, 0),
  ('demo-002', 'https://www.instagram.com/reel/demo-002', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=700&q=85', 'Как я удвоил доход за 6 месяцев', 'Практический план роста дохода.', 'Полгода назад мой доход стоял на месте.', 'Я выбрал один навык, поставил измеримую цель и каждую неделю анализировал результат.', 'Напиши «план» — отправлю чек-лист.', 45, 920000, 1100, 205, 64, FALSE, 1),
  ('demo-003', 'https://www.instagram.com/reel/demo-003', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=700&q=85', 'Простой и полезный завтрак за 5 минут', 'Быстрый рецепт на каждый день.', 'Нет времени на полезный завтрак?', 'Смешай яйца, зелень и овощи, обжарь две минуты с каждой стороны.', 'Сохрани рецепт, чтобы приготовить утром.', 28, 640000, 890, 77, 31, TRUE, 2),
  ('demo-004', 'https://www.instagram.com/reel/demo-004', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=700&q=85', 'Мой подход к продуктивности', 'Система спокойной продуктивности.', 'Список задач не должен управлять твоим днём.', 'Выбери три результата дня и сначала сделай самый сложный.', 'Подпишись за новыми рабочими системами.', 28, 1400000, 2300, 402, 118, FALSE, 3),
  ('demo-005', 'https://www.instagram.com/reel/demo-005', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'https://images.unsplash.com/photo-1568602471122-7832951cc4c5?auto=format&fit=crop&w=700&q=85', 'Главный навык в 2026 году', 'Почему умение быстро учиться стало главным преимуществом.', 'Этот навык важнее любой профессии.', 'Умение быстро находить, проверять и применять знания ускоряет любой рост.', 'Отправь это видео тому, кто много учится.', 51, 780000, 1500, 184, 52, FALSE, 4),
  ('demo-006', 'https://www.instagram.com/reel/demo-006', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'https://images.unsplash.com/photo-1537996194471-e657df975ab4?auto=format&fit=crop&w=700&q=85', 'Почему стоит посетить Бали хотя бы раз', 'Маршрут по Бали без туристических ловушек.', 'На Бали есть места, которые не показывают в путеводителях.', 'Начни с востока острова, выдели день на водопады и встречай закат у океана.', 'Сохрани маршрут для будущей поездки.', 34, 2100000, 3400, 526, 201, TRUE, 5),
  ('demo-007', 'https://www.instagram.com/reel/demo-007', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'https://images.unsplash.com/photo-1531123897727-8f129e1688ce?auto=format&fit=crop&w=700&q=85', '5 привычек для чистой кожи', 'Простые ежедневные привычки.', 'Уход не обязан состоять из десяти банок.', 'Очищение, увлажнение, SPF, чистая наволочка и стабильный режим сна.', 'Сохрани список и проверь себя.', 29, 690000, 1200, 142, 38, FALSE, 6),
  ('demo-008', 'https://www.instagram.com/reel/demo-008', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=700&q=85', 'Тренировка дома без оборудования', 'Короткая тренировка на всё тело.', 'Для этой тренировки тебе не нужен зал.', 'Три круга: приседания, отжимания, выпады и планка по 30 секунд.', 'Сохрани и сделай тренировку вечером.', 40, 550000, 980, 96, 24, FALSE, 7)
) AS seed(platform_reel_id, source_url, video_url, thumbnail_url, title, description, hook_text, script_text, cta_text, duration_seconds, views_count, likes_count, comments_count, shares_count, is_favorite, age_days)
WHERE c.instagram_handle = '@alyona.health'
ON CONFLICT (platform_reel_id) DO NOTHING;

INSERT INTO scripts (reel_id, title, hook_text, script_text, cta_text, status)
SELECT id, title, hook_text, script_text, cta_text, 'ready'
FROM reels
WHERE platform_reel_id IN ('demo-001', 'demo-002', 'demo-003')
  AND NOT EXISTS (SELECT 1 FROM scripts WHERE scripts.reel_id = reels.id);

INSERT INTO tags (name) VALUES ('здоровье'), ('продуктивность'), ('путешествия')
ON CONFLICT (name) DO NOTHING;
