# ⛽ KogdaBenz — «Когда лучше заправиться?»

Система временного прогнозирования для водителей Новороссийска.
Мы не копируем чужие карты наличия топлива — мы отвечаем на вопрос **«КОГДА»**:
когда на конкретной АЗС вероятно вернётся топливо и когда лучше заехать.

> Цель: собрать историю изменений АЗС → найти закономерности → предсказать окно
> пополнения → проверять прогнозы на фактах → улучшать точность.

---

## Как работает система

```
GdeBenz API (широкая рамка: Новороссийск+Геленджик+Анапа+Крымск, ~137 АЗС)
        ↑ каждые 10 минут будит cron-job.org → workflow_dispatch
collector.js (GitHub Actions, чистый fetch):
  станции → наблюдения → события (топливо/очереди, gap-детектор, фильтр противофазы)
  → народные отметки user_feedback → события → уборка наблюдений >30 дней
  → Telegram-лента событий (с учётом тихого режима bot_meta.notify)
        ↓
Supabase: stations / observations / events / predictions /
          user_feedback / bot_meta + вьюхи (security_invoker)
        ↓
predictor.js v1.1 + target_date:
  медиана±σ по Москве, пулинг own→brand→city, модель длительности дефицита,
  прогноз прицеливается на "сегодня" или "завтра" в зависимости от текущего времени
        ↓
verifier.js (02:10 MSK, ежедневно):
  оценивает вчерашние прогнозы по фактам → SUCCESS/MISS → is_verified
        ↓
digest.js (08:00 MSK, ежедневно): сводка за 24 ч в Telegram
bot.js (каждые 5 мин): читает обновления Telegram, отвечает на кнопки /status /predict /digest /quiet /loud
        ↓
Сайт (GitHub Pages): карточки + пульс города (светлый премиум SVG)
```

---

## Состав репозитория

| Файл | Роль | Статус |
|---|---|---|
| `collector.js` | Сборщик v4: широкий сбор, gap-детектор, фильтр противофазы, народные отметки, уборка, телеграм-лента | ✅ прод |
| `predictor.js` | Предиктор v1.1 + target_date: пулинг own/brand/city, модель дефицита, ETA, прицел на дату | ✅ прод |
| `verifier.js` | Верификатор: ночная оценка прогнозов по фактам (SUCCESS/MISS) | ✅ прод |
| `digest.js` | Утренний дайджест за 24 ч | ✅ прод |
| `bot.js` | Бот с кнопками: отчёты и тихий режим (серверлесс, без сервера) | ✅ прод |
| `index.html` | Сайт v2: карточки + пульс города (светлый премиум SVG) | ✅ прод |
| `.github/workflows/collect.yml` | dispatch + «Telegram on failure» | ✅ прод |
| `.github/workflows/digest.yml` | dispatch дайджеста | ✅ прод |
| `.github/workflows/verify.yml` | dispatch верификатора | ✅ прод |
| `.github/workflows/bot.yml` | dispatch бота (каждые 5 мин) | ✅ прод |
| `README.md` | Этот документ | ✅ |
| `statistics.js`, `confidence.js`, `handler.js`, `comments.js`, `events.js`, `gdebenz.js`, `scheduler.js`, `setup.js` | Черновики-спецификации этапов E/F | 📐 затем в `legacy/` |

Внешние сервисы:
- **cron-job.org** — основной будильник:
  - каждые 10 минут — `collect`
  - каждые 5 минут — `bot`
  - ежедневно 08:00 MSK — `digest`
  - ежедневно 02:10 MSK — `verify`
  Все через GitHub API `workflow_dispatch`. PAT fine-grained: Actions Read and write, только этот репозиторий.
- **Telegram-бот «КогдаБенз Алерт»** — события по-русски, 🔮 первые прогнозы, 🚨 аварии, 🌅 дайджест, кнопки-отчёты, тихий режим.
- Родной GitHub `schedule` на этом репозитории **не срабатывал ни разу** — внешний будильник считается основным.

---

## База данных (Supabase)

| Таблица | Что хранит |
|---|---|
| `stations` | Реестр АЗС (external_id = osm_id, brand, address, lat/lon, source) |
| `observations` | Снимки статусов каждые 10 мин (+ data_freshness_minutes, queue_level) |
| `events` | Изменения: топливные, очередные, народные, из комментариев |
| `predictions` | Окна прогнозов + prediction_source + based_on_stations + expected_restore_at + target_date + result/is_verified |
| `user_feedback` | Структурированные народные отметки: feedback_type + fuel_type + queue_size + comment_text |
| `bot_meta` | Состояние бота (update_offset, notify режим) — только service_role |
| `comments` | Текстовые комментарии (источник не даёт — таблица спит) |

**Вьюхи (обход лимита Supabase REST в 1000 строк + безопасный RLS-режим):**
- `station_counts` — настоящее общее число наблюдений по станции
- `station_hourly` — почасовая доступность АИ-95 для графиков сайта
- `city_hourly` — пульс города: очереди и АИ-95 по часам

Все вьюхи установлены с `security_invoker = true` — RLS-политики применяются под маской запросившего, а не создателя вьюхи (закрытое замечание советника безопасности).

**Белые списки** (check-constraints):
- `events_event_type_check`: fuel_disappeared, fuel_restored, fuel_available, fuel_unavailable, possible_delivery, queue_high, queue_low, queue_appeared, queue_gone
- `user_feedback_insert` (RLS policy): feedback_type/fuel_type/queue_size только из списка чипсов, device_id обязателен

Правило: новый тип события = сначала расширить constraint, потом писать код.

---

## Что сделано (статус на вечер 16.09.2026)

- [x] Этап 1: исследован реальный API GdeBenz (формат, защита от ботов, отсутствие текстовых комментариев)
- [x] Этап 2: коллектор на GitHub Actions; «паспорт браузера» + 3 повтора против 502
- [x] Этап 3: история наблюдений; широкая рамка 4 городов (~137 АЗС за запуск)
- [x] Этап 4: детектор событий; **gap-детектор** (окно 36 ч сквозь ночные null) + **фильтр противофазы** (дизельный скачок при скачке бензина = артефакт состава отметок, не поставка)
- [x] Безопасность: service_role только в секретах; RLS везде; вьюхи security_invoker; белый список user_feedback; аноним = select
- [x] Этап 5: предиктор v1 → v1.1 (пулинг own→brand→city, модель длительности дефицита, expected_restore_at, всё по Москве)
- [x] **Первый 🟢 fuel_restored** (15.09, 12:11 — Газпром · Кольцевая, 19, АИ-95)
- [x] **Первые прогнозы** (15.09, 21:31 — пять Роснефтей/дизель, source=brand, 5 станций)
- [x] Этап 6/D: **верификатор v1** с прицелом `target_date` (сегодня/завтра), первые вердикты 0/5 как калибровочная точка
- [x] Этап 8/9: сайт v2 (факт/прогноз/точность раздельно, ≈% по свежести, почасовой чарт, избранное, гео-сортировка, народные кнопки с топливом и размером очереди)
- [x] **Пульс города**: светлый премиум SVG (светящиеся области спроса/предложения, колонны света событий, KPI-чипы, метка «СЕЙЧАС», анимация прорисовки, табы 24 ч / 7 дн)
- [x] **Бот v2**: кнопки-отчёты (📊 Сводка / 🔮 Прогнозы / 🌅 Дайджест), тихий/громкий режим, serverless на cron-job.org
- [x] Бренды логотипами: BRAND_LOGOS, детектор кириллицы+латиницы, onerror-фолбэк на эмодзи
- [x] Дайджест 08:00 MSK + точность прогнозов в дайджесте (при ≥10 проверок)
- [x] Гигиена базы: автоудаление наблюдений старше 30 дней
- [x] Советник безопасности Supabase: вьюхи security_invoker, белый список user_feedback
- [ ] Этап 7/F: модель v2 (день недели, триггер очереди с лагом, загруженность, биржевой фон)
- [ ] «Тихие часы» per-АЗС (закрыть обещание hero: «и меньше очередей»)
- [ ] Кнопка «поделиться прогнозом» (Web Share API)
- [ ] Черновики → `legacy/`; резервная копия базы раз в неделю
- [ ] Публичный Telegram-канал с утренним дайджестом для города

---

## Правила проекта (обязательны для любого нового кода)

1. Запросы к GdeBenz — только с `BROWSER_HEADERS` и повторами.
2. Рабочий код не переписываем с нуля: возможности дописываются шагами.
3. Новые скрипты — один файл, чистый fetch, без npm-зависимостей.
4. Всё время — явно по Москве (UTC+3): Actions и база живут в UTC.
5. Факт и прогноз в интерфейсе разделены всегда (ТЗ §15).
6. Точность показываем только при ≥10 проверенных прогнозах (ТЗ §12).
7. **Прогноз прицеливается на дату** (`target_date`): если окно уже в прошлом сегодня — прогноз на завтра. Верификатор трогает только вчерашние цели.
8. Официальные городские сводки не используем (полевая проверка); Яндекс/2GIS/банки не парсим (ToS, антибот) — данные берём легально: GdeBenz API + своя толпа.
9. Очередь — опережающий сигнал: появилась раньше отметок топлива.
10. **Фильтр противофазы**: если дизель и бензин переключились в противоположные стороны в одном снимке — дизельный флажок выбрасываем (артефакт состава отметок, не поставка).
11. Новый тип события → сначала белый список constraint, потом код.
12. Помним про лимит Supabase REST (1000 строк): агрегаты считаем вьюхами, а не выгрузкой сырых строк.
13. Вьюхи — всегда `security_invoker = true`, чтобы RLS работал сквозь них.
14. Народные отметки с структурой (fuel_type, queue_size, comment) → в базе только значения из белого списка (RLS policy).
15. Серверлесс где возможно: бот без сервера, на cron-job.org + Supabase meta-таблица.

---

## Запуск и проверка

- Ручной прогон: Actions → любой workflow → Run workflow.
- Норма collect: `Станций в ответе: ~137 / Наблюдений записано: ~137 / Уборка: HTTP 204 / ✅ Цикл завершён` + блок предиктора.
- Норма digest: одно сообщение в Telegram вида «🌅 КогдаБенз · дайджест за сутки…».
- Норма bot: `/start` в Telegram → клавиатура кнопок → «📊 Сводка города» → отчёт о дефицитах и очередях.
- Норма verify: ночью в логе построчные ✅ SUCCESS / ❌ MISS и сводка точности.
- SQL-самопроверка:
```sql
select event_type, count(*) from events group by event_type;
select count(*) filter (where timestamp > now() - interval '1 hour') as за_час,
       count(*) as всего from observations;
select target_date, result, count(*) from predictions group by 1,2 order by 1 desc;
select key, value from bot_meta;
```
- Table Editor показывает время в UTC; новороссийское = +3.

---

## Безопасность

- Секреты GitHub: `SUPABASE_URL`, `SUPABASE_KEY` (service_role), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- В клиентский код (`index.html`) — только anon-ключ.
- PAT для cron-job.org: fine-grained, Actions Read and write, один репозиторий; ротация при любой утечке.
- Антиспам народных отметок: ≤3 с устройства за 30 минут (localStorage) + RLS-белый список типов/топлива/размеров очереди.
- Вьюхи `security_invoker` = RLS применяется под маской запросившего.
- `bot_meta` доступна только service_role — состояние бота не торчит наружу.

---

## Troubleshooting

| Симптом | Причина / лечение |
|---|---|
| `GdeBenz ответил 502/403` | Защита от ботов или чих: BROWSER_HEADERS + 3 повтора уже в коде; план Б — cookie в секреты |
| `violates check constraint events_event_type_check` | Новый тип события не в белом списке → расширить constraint |
| Dispatch от cron-job: `404 Not Found` | Workflow-файл лежит не в `.github/workflows/` (классика мобильного GitHub: папка-двойник) |
| `ReferenceError: X is not defined` после заплатки | Объявление переменной внутри блока `if` — вынести на уровень использования |
| Сайт показывает мало наблюдений/пустой чарт | Упёрлись в лимит 1000 строк REST — брать агрегаты из вьюх `station_counts`/`station_hourly` |
| `NaN дн назад` в карточке | Перепутан порядок распаковки Promise.all с порядком запросов; сверить имена |
| Родной cron молчит | Известная особенность этого репозитория — основной будильник cron-job.org |
| Красный запуск | Прилетит 🚨 в Telegram; смотреть шаг Run collector |
| Карусель 🔮/🧮: прогноз создаётся и тут же MISS | Не установлен target_date — прогноз целился на уже прошедшее окно; после миграции target_date цикл останавливается |
| Дизельные «🟢 вернулся» в парах с бензинными 🔴 | Артефакт состава отметок: фильтр противофазы в collector.js должен вырезать дизельный флажок |
| Security Definer View в советнике Supabase | Вьюхи должны быть `security_invoker = true` (см. приложение SQL) |
| RLS Policy Always True на user_feedback | Заменить на белый список типов/топлива/очередей (см. приложение SQL) |
| Бот молчит больше 5 минут | Проверить: cron-job.org → bot-джоба → Actions → бот-воркфлоу; `bot_meta.update_offset` должен расти |

---

## Приложение: опорный SQL

```sql
-- белый список событий (актуальный)
alter table public.events drop constraint events_event_type_check;
alter table public.events add constraint events_event_type_check
check (event_type in (
  'fuel_disappeared','fuel_restored','fuel_available','fuel_unavailable',
  'possible_delivery','queue_high','queue_low','queue_appeared','queue_gone'));

-- target_date: прогноз прицеливается на конкретный день
alter table public.predictions add column if not exists target_date date;
update public.predictions
set target_date = (created_at at time zone 'Europe/Moscow')::date
where target_date is null;

-- вьюхи агрегатов (security_invoker — RLS работает сквозь вьюху)
create or replace view public.station_counts as
select station_id, count(*) as total from public.observations group by station_id;
alter view public.station_counts set (security_invoker = true);

create or replace view public.station_hourly as
select station_id, date_trunc('hour', timestamp) as hour,
       count(*) as total,
       count(*) filter (where fuel_95_status = true) as available_95
from public.observations group by 1, 2;
alter view public.station_hourly set (security_invoker = true);

create or replace view public.city_hourly as
select date_trunc('hour', o.timestamp) as hour,
       count(*) as marks,
       count(*) filter (where o.queue_level = 'high') as queue_marks,
       count(*) filter (where o.fuel_95_status = true) as avail95,
       count(*) filter (where o.fuel_95_status is not null) as known95
from public.observations o
join public.stations s on s.id = o.station_id
where s.lat >= 44.60 and s.lat <= 44.85 and s.lon >= 37.55 and s.lon <= 38.05
group by 1;
alter view public.city_hourly set (security_invoker = true);

-- user_feedback: белый список в RLS вместо with check (true)
do $$
declare r record;
begin
  for r in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'user_feedback' loop
    execute format('drop policy if exists %I on public.user_feedback', r.policyname);
  end loop;
end $$;

create policy user_feedback_select on public.user_feedback
  for select to anon, authenticated using (true);

create policy user_feedback_insert on public.user_feedback
  for insert to anon, authenticated
  with check (
    device_id is not null
    and feedback_type in ('delivery','available','unavailable','queue','free')
    and (fuel_type is null or fuel_type in ('92','95','diesel','all'))
    and (queue_size is null or queue_size in ('small','medium','large'))
  );

-- память бота (только service_role видит)
create table if not exists public.bot_meta (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.bot_meta enable row level security;
```

---

## Источники данных

- **GdeBenz** (основной): отметки водителей, статусы, цены, очереди. Текстовых комментариев в открытом API нет.
- **Своя толпа**: структурированные кнопки на сайте (5 типов × топливо × размер очереди × комментарий) → `user_feedback` → события `source='user_feedback'`.
- Отклонено сознательно: официальные сводки (недостоверны), парсинг Яндекса/2GIS/банков (ToS и антибот), случайные Telegram-каналы (предупреждение Минэнерго).
- Кандидат для модели v2: биржевые индексы СПбМТСБ/BenzUp как макропризнак дефицита.

---

## Хронология проекта

| Дата | Событие |
|---|---|
| 14.09.2026 | Первая версия сайта, Supabase-подключение |
| 15.09.2026 утро | Первый рабочий коллектор, первые наблюдения |
| 15.09.2026 день | Gap-детектор, фильтр противофазы, широкая рамка, телеграм-лента, дайджест, пульс города, бренды-логотипы |
| 15.09.2026 12:11 | **Первый 🟢 fuel_restored** (Газпром, АИ-95) |
| 15.09.2026 21:31 | **Первые прогнозы** (5 Роснефтей/дизель, brand-пул) |
| 15.09.2026 вечер | Верификатор v1 + target_date, бот v2 с кнопками, security_invoker |