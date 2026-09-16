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
collector.js (GitHub Actions, чистый fetch, v4):
  станции → наблюдения → события (топливо/очереди, gap-детектор, фильтр противофазы)
  → народные отметки user_feedback → события → уборка наблюдений >30 дней
  → Telegram-лента событий (с учётом тихого режима bot_meta.notify)
        ↓
Supabase: stations / observations / events / predictions /
          user_feedback / bot_meta + вьюхи (security_invoker)
        ↓
predictor.js v1.4:
  медиана±σ по Москве, пулинг own→brand→city, модель длительности дефицита,
  k-NN по эпизодам "исчезло→вернулось" (порог ≥8, иначе медиана-фолбэк),
  features-снапшот в момент прогноза + режим города (NORMAL/LOCAL/CITY/RECOVERY),
  гейт молчащих станций (data_freshness_minutes > 7 сут), baseline для сравнения,
  прицел на target_date "сегодня"/"завтра"
        ↓
verifier.js v1.2 (02:10 MSK, ежедневно):
  оценивает вчерашние прогнозы по фактам → SUCCESS/MISS → is_verified
  + величина ошибки: actual_restore_at, error_minutes, baseline_error_minutes
  + блок TRAINING DATA в логе (MAE/медиана/p90: модель против baseline)
        ↓
prediction_training (вьюха): верифицированные прогнозы с features и ошибкой
        ↓ (по мере накопления ≥100 строк)
калибровка confidence по децилям · тюнинг k-NN · shadow-сравнение версий
        ↓
digest.js (08:00 MSK, ежедневно): сводка за 24 ч в Telegram
bot.js (каждые 5 мин): читает обновления Telegram, отвечает на кнопки /status /predict /digest /quiet /loud
        ↓
Сайт (GitHub Pages): карточки + тепловая матрица + пульс города (день/неделя/месяц)
  + блок «Почему такой прогноз» из features + «Куда ехать» с гейтом свежести
```

---

## Состав репозитория

| Файл | Роль | Статус |
|---|---|---|
| `collector.js` | Сборщик v4: широкий сбор, gap-детектор, фильтр противофазы, народные отметки, уборка, телеграм-лента. Парсинг комментариев убран (открытого API комментариев нет) | ✅ прод |
| `predictor.js` | Предиктор v1.4: пулинг own/brand/city, модель дефицита + k-NN по эпизодам, снапшот features, режим города, гейт молчащих станций, baseline_restore_at | ✅ прод |
| `verifier.js` | Верификатор v1.2: ночная оценка по фактам (SUCCESS/MISS) + error_minutes/baseline_error_minutes + TRAINING DATA (MAE/медиана/p90) | ✅ прод |
| `digest.js` | Утренний дайджест за 24 ч | ✅ прод |
| `bot.js` | Бот с кнопками: отчёты и тихий режим (серверлесс, без сервера) | ✅ прод |
| `index.html` | Сайт v2.2: карточки + тепловая матрица + пульс день/неделя/месяц + мультивыбор + «Почему такой прогноз» + очереди по selling-станциям + «Куда ехать» с гейтом свежести | ✅ прод |
| `.github/workflows/collect.yml` | dispatch + «Telegram on failure» | ✅ прод |
| `.github/workflows/digest.yml` | dispatch дайджеста | ✅ прод |
| `.github/workflows/verify.yml` | dispatch верификатора | ✅ прод |
| `.github/workflows/bot.yml` | dispatch бота (каждые 5 мин) | ✅ прод |
| `README.md` | Этот документ | ✅ |
| `statistics.js`, `confidence.js`, `handler.js`, `comments.js`, `events.js`, `gdebenz.js`, `scheduler.js`, `setup.js` | Черновики-спецификации этапов E/F (`confidence.js` — легаси-дубль верификатора на supabase-js, не используется) | 📐 затем в `legacy/` |

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
| `events` | Изменения: топливные, очередные, народные |
| `predictions` | Окна прогнозов + prediction_source + based_on_stations + expected_restore_at + baseline_restore_at + target_date + result/is_verified + features (jsonb-снапшот признаков) + model_version + actual_restore_at + error_minutes + baseline_error_minutes |
| `user_feedback` | Структурированные народные отметки: feedback_type + fuel_type + queue_size + comment_text |
| `bot_meta` | Состояние бота (update_offset, notify режим) — только service_role |
| `comments` | Текстовые комментарии (источник не даёт — таблица спит; шаг парсинга убран в collector v4) |

**Вьюхи (обход лимита Supabase REST в 1000 строк + безопасный RLS-режим):**
- `station_counts` — настоящее общее число наблюдений по станции
- `station_hourly` — почасовая доступность АИ-95 для графиков карточек
- `city_hourly` — пульс города: очереди и АИ-95 по часам (кардиограмма «День»); колонка `selling` — станции с любым топливом (знаменатель честных очередей)
- `city_fuel_hourly` — 4 ряда тепла по часам (АИ-92/95/ДТ/Очереди) + `selling` для тепловой матрицы
- `city_daily_events` — дневные агрегаты исчезновений/возвратов для кардиограмм «Неделя»/«Месяц»
- `prediction_training` — учебная выборка: верифицированные прогнозы с `error_minutes` и `features` (вход калибровки и тюнинга k-NN)

Все вьюхи установлены с `security_invoker = true` — RLS-политики применяются под маской запросившего, а не создателя вьюхи (закрытое замечание советника безопасности).

**Белые списки** (check-constraints):
- `events_event_type_check`: fuel_disappeared, fuel_restored, fuel_available, fuel_unavailable, possible_delivery, queue_high, queue_low, queue_appeared, queue_gone
- `user_feedback_insert` (RLS policy): feedback_type/fuel_type/queue_size только из списка чипсов, device_id обязателен

Правило: новый тип события = сначала расширить constraint, потом писать код.

---

## Что сделано (статус на ночь 17→18.09.2026)

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
- [x] **Тепловая матрица города** (16.09): 4 ряда × 24 часа из `city_fuel_hourly`, линия «сейчас» с 4 точками, цветовая легенда 4 уровня, статусы «есть/мало/нет» по каждой строке
- [x] **Кардиограмма с тремя режимами** (16.09): День (24 почасовых столбца) / Неделя (7 дневных) / Месяц (30 дневных) с переключением в шапке, подписью диапазона и колоннами событий из `city_daily_events`
- [x] **Мультивыбор отметок** (16.09): чек-лист «есть/нет 92/95/ДТ + очередь 2–3/4–6/7+/100+ + привезли + свободно» → одна отправка создаёт до N строк user_feedback; взаимоисключение «есть/нет» по топливу, одиночный выбор очереди
- [x] **Дайджест-панель** (16.09): 6 метрик в два ряда (вернулось / кончилось / пик очередей / отметок народа / прогнозов активно / точность верификатора) + полоса средней доступности АИ-95 за сутки + избранное
- [x] **Защищённая загрузка данных** (16.09): каждый запрос в `loadPulse` в своём try/catch — упавшая вьюха не убивает кардиограмму/тепло/чипы вместе с собой; контрольная перерисовка через 400 мс
- [x] **Честные пустые состояния** (16.09): серые плашки «копит наблюдения» вместо невидимых ячеек, подпись «мало дней для диапазона» когда данных меньше двух
- [x] **Чипы «Сейчас · АИ-95 есть»** (16.09): формулировка «N из M АЗС» вместо абстрактного процента, плюс «Пик спроса» и «Спокойно» из тепловой матрицы
- [x] **Починка кардиограммы Неделя/Месяц** (17.09): `sameDay` получал объект-бакет вместо его даты (`b.getFullYear is not a function`); для отлова поставлена временная отладочная плашка `dbgShow` на сайте
- [x] **Шапка сайта v2** (17.09): двуцветный вордмарк «КогдаБенз», слоган «Данные о топливе. Вовремя.», иконка с полосками скорости; компоновка слева, «Рядом» справа
- [x] **Обучающий контур v1.2** (17.09): миграция (`actual_restore_at`, `error_minutes`, `features jsonb`, `model_version`, индекс, вьюха `prediction_training`); снапшот признаков в момент прогноза (час/день недели, возраст дефицита, очередь и тренд, доступность АИ-95 в городе, соседи без 95 в 3 км, возвраты/исчезновения за 6 ч, режим города NORMAL/LOCAL_SHORTAGE/CITY_SHORTAGE/RECOVERY)
- [x] **Верификатор v1.2** (17.09): величина ошибки вместо голого SUCCESS/MISS — факт = первый `fuel_restored` после создания прогноза, точка ожидания = `expected_restore_at` или середина окна; знак ошибки = направление («+» вернули позже, «−» раньше)
- [x] **Предиктор v1.3 / k-NN** (17.09): база эпизодов «исчезло→вернулось» с контекстом из событий (волна дефицита ±2 ч, очередь за 90 мин до, бренд, час/день недели); похожие ситуации для ETA при поддержке ≥8, иначе медиана-фолбэк — прод не рискует на малых данных
- [x] **Блок «Почему такой прогноз»** (17.09): чипы-причины из `features` в карточке АЗС (режим города, возраст дефицита, тренд очереди, k-NN с P<2ч, соседи без АИ-95); у прогнозов без снапшота блок не рисуется
- [x] **Collector v4** (17.09): шаг парсинга комментариев удалён (открытого API комментариев у GdeBenz нет — шаг делал ~137 пустых запросов и ~17 с sleep за цикл); прогон 58 с → ~10 с, меньше антибот-риска
- [x] **Предиктор v1.4 / гейт молчащих станций** (ночь 17→18.09): станция снимается с прогнозов, если её данные источника старше 7 суток (или свежесть null и нет ненулевого статуса в окне наблюдений); мёртвые АЗС не занимают PENDING и не разбавляют точность
- [x] **Честные очереди в дефицит** (ночь 17→18.09): вьюхи `city_hourly`/`city_fuel_hourly` + колонка `selling` (наблюдения с любым топливом); строка «Очереди» тепловой матрицы и линия спроса кардиограммы нормируются на торгующие станции, а не на все — в дефицит очередь наконец видна
- [x] **«Куда ехать» с гейтом свежести** (ночь 17→18.09): кноп советует только станции с данными ≤6 ч; приоритет «АИ-95 есть → любое топливо есть → открытое окно пополнения → окно в ближайшие 3 ч»; метка «· топливо есть» отделяет факт от прогноза
- [x] **Baseline-сравнение** (ночь 17→18.09): `baseline_restore_at`/`baseline_error_minutes` — на одном прогнозе лежат ошибка модели и ошибка голой медианы; блок TRAINING DATA в логе верификатора (MAE/медиана/p90 по обеим)
- [ ] Калибровка confidence по децилям (старт при ≥100 строк в `prediction_training`)
- [ ] Shadow-сравнение версий модели по `model_version` (прод = лучшая по медиане |error|)
- [ ] Мультирегион: разведка покрытия GdeBenz → колонка region и пулинг own→brand→region → юг как донор обучения → переключатель города на сайте
- [ ] Очереди этап 2: народные события queue_high/queue_appeared в почасовом q; модельная оценка очереди в дефицит с явной подписью «оценка»
- [ ] Убрать отладочную плашку `dbgShow` с сайта (после стабилизации кардиограммы)
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
16. **Отказоустойчивость сайта**: каждый внешний запрос к вьюхе в своём try/catch; отрисовка блоков не падает от одной упавшей вьюхи.
17. **Пустые состояния видимы**: нет данных → серая плашка с объяснением, не «пусто на белом».
18. **Мультивыбор в UI**: если пользователь может отметить несколько фактов одновременно — отправляем массивом, не заставляем выбирать один.
19. **Обучение только на верифицированных исходах**: непроверенные прогнозы в тренировочную выборку не попадают; верификатор — единственные ворота обучения.
20. **`CREATE OR REPLACE VIEW`: новые колонки только дописываются в конец** — иначе ошибка 42P16 «cannot change name of view column».
21. **Изменения модели — аддитивно с фолбэком на малых данных**: k-NN работает при поддержке ≥8 эпизодов, иначе старая медиана; прод-поведение при пустой истории не меняется.
22. **Измерение раньше усложнения**: сначала `error_minutes`/`baseline_error_minutes` и TRAINING DATA, потом новые модели; тяжёлое ML (бустинг/нейросети) — не раньше сотен верифицированных прогнозов.

---

## Запуск и проверка

- Ручной прогон: Actions → любой workflow → Run workflow.
- Норма collect: `Станций в ответе: ~137 / Наблюдений записано: ~137 / Уборка: HTTP 204 / ✅ Цикл завершён` + блок предиктора: `Контекст города: … режим …`, `Эпизодов дефицита для k-NN: N`, `Создано: N, обновлено: N, пропущено: N, молчащих станций (>72ч): N`.
- Норма digest: одно сообщение в Telegram вида «🌅 КогдаБенз · дайджест за сутки…».
- Норма bot: `/start` в Telegram → клавиатура кнопок → «📊 Сводка города» → отчёт о дефицитах и очередях.
- Норма verify: ночью в логе построчные ✅ SUCCESS / ❌ MISS с величиной ошибки (`· ошибка +N мин`) и сводка `TRAINING DATA: с ошибкой: N | модель: MAE … | baseline: …`.
- Норма сайта: тепловая матрица 4×24 раскрашена (в дефицит строка «Очереди» краснеет по selling-станциям), кардиограмма переключается День/Неделя/Месяц с обновлением подписи диапазона, мультивыбор в карточке создаёт несколько строк в user_feedback, блок «Почему такой прогноз» показывает чипы причин.
- SQL-самопроверка:
```sql
select event_type, count(*) from events group by event_type;
select count(*) filter (where timestamp > now() - interval '1 hour') as за_час,
       count(*) as всего from observations;
select target_date, result, count(*) from predictions group by 1,2 order by 1 desc;
select key, value from bot_meta;
-- обучение:
select count(*) from prediction_training;
select count(*) filter (where error_minutes is not null) as с_ошибкой,
       count(*) filter (where baseline_error_minutes is not null) as с_baseline
from predictions where is_verified;
-- для сайта:
select count(*) from city_hourly where hour > now() - interval '7 days';
select count(*) from city_fuel_hourly where hour > now() - interval '24 hours';
select count(*) from city_daily_events where day > now() - interval '30 days';
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
| `SyntaxError: Unexpected end of input` после серии заплаток | Разбаланс фигурных скобок при ручной вставке кусков — заменить файл целиком на выверенный или проверить скобки последней вставки |
| Сайт показывает мало наблюдений/пустой чарт | Упёрлись в лимит 1000 строк REST — брать агрегаты из вьюх `station_counts`/`station_hourly` |
| `NaN дн назад` в карточке | Перепутан порядок распаковки Promise.all с порядком запросов; сверить имена |
| Родной cron молчит | Известная особенность этого репозитория — основной будильник cron-job.org |
| Красный запуск | Прилетит 🚨 в Telegram; смотреть шаг Run collector |
| Карусель 🔮/🧮: прогноз создаётся и тут же MISS | Не установлен target_date — прогноз целился на уже прошедшее окно; после миграции target_date цикл останавливается |
| Дизельные «🟢 вернулся» в парах с бензинными 🔴 | Артефакт состава отметок: фильтр противофазы в collector.js должен вырезать дизельный флажок |
| Security Definer View в советнике Supabase | Вьюхи должны быть `security_invoker = true` (см. приложение SQL) |
| RLS Policy Always True на user_feedback | Заменить на белый список типов/топлива/очередей (см. приложение SQL) |
| Бот молчит больше 5 минут | Проверить: cron-job.org → bot-джоба → Actions → бот-воркфлоу; `bot_meta.update_offset` должен расти |
| Тепловая матрица серая / кардиограмма пустая | Вьюха `city_fuel_hourly` или `city_daily_events` не создана — выполнить SQL из приложения |
| Дайджест показывает нули при живом теглайне | `renderNow()` не дёргается после `loadPulse()` — должен быть в setTimeout(400ms) |
| Кардиограмма не переключается Неделя/Месяц | `buildBuckets()` должен учитывать `mgRangeH` и агрегировать по дням, не по часам |
| Кардиограмма Неделя/Месяц: `b.getFullYear is not a function` | `sameDay(nowD, b)` получил объект-бакет вместо даты: правильно `sameDay(nowD, b.t)` |
| `42P16 cannot change name of view column` при пересоздании вьюхи | В `CREATE OR REPLACE VIEW` новые колонки дописываются только в конец (см. `selling`/`baseline_error_minutes` в приложении) |
| Строка «Очереди» серая, линия спроса нулевая после патча | Новая колонка вьюхи (`selling`) не добавлена в явный `select=` запроса сайта — дописать |
| Очереди «всё зелёное» при живых пробках | Знаменатель «все станции» размывает очередь дефицита; очереди нормируются на `selling` (торгующие станции) |
| «Куда ехать» ведёт на АЗС с «нет данных» | Кнопка не смотрела свежесть: гейт `data_freshness_minutes ≤ 360` и приоритет «топливо есть сейчас» |
| «Молчащих станций: 28 из 29» после гейта | Гейт по возрасту строки или ненулевого статуса непригоден в дефицит (строки пишутся каждый цикл, статус — роскошь); гейт только по `data_freshness_minutes > 7 сут` |
| `prediction_training = 0` сразу после миграции | Норма до первого verify новым кодом (02:10 MSK): старый верификатор `error_minutes` не писал |
| Мультивыбор отправляет только один факт | `fbSend` должен собирать массив `rows` из `.selected`, а не брать `fbDraft` |

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

-- обучающий контур v1.2/v1.4: ошибка прогноза, снапшот признаков, baseline
alter table public.predictions add column if not exists actual_restore_at timestamptz;
alter table public.predictions add column if not exists error_minutes int;
alter table public.predictions add column if not exists features jsonb;
alter table public.predictions add column if not exists model_version text default 'v1.1';
alter table public.predictions add column if not exists baseline_restore_at timestamptz;
alter table public.predictions add column if not exists baseline_error_minutes int;
create index if not exists idx_predictions_verified_error
  on public.predictions (is_verified, model_version)
  where is_verified = true and error_minutes is not null;

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

-- пульс города: очереди и АИ-95 по часам (кардиограмма "День")
-- selling = наблюдения с любым топливом: знаменатель честных очередей
create or replace view public.city_hourly as
select date_trunc('hour', o.timestamp) as hour,
       count(*) as marks,
       count(*) filter (where o.queue_level = 'high') as queue_marks,
       count(*) filter (where o.fuel_95_status = true) as avail95,
       count(*) filter (where o.fuel_95_status is not null) as known95,
       count(*) filter (where o.fuel_92_status = true or o.fuel_95_status = true
                             or o.diesel_status = true) as selling
from public.observations o
join public.stations s on s.id = o.station_id
where s.lat >= 44.60 and s.lat <= 44.85 and s.lon >= 37.55 and s.lon <= 38.05
group by 1;
alter view public.city_hourly set (security_invoker = true);

-- тепловая матрица: 4 ряда × 24 часа (АИ-92/95/ДТ/Очереди) + selling
create or replace view public.city_fuel_hourly as
select date_trunc('hour', o.timestamp) as hour,
       count(*) filter (where o.fuel_92_status = true) as a92,
       count(*) filter (where o.fuel_92_status is not null) as k92,
       count(*) filter (where o.fuel_95_status = true) as a95,
       count(*) filter (where o.fuel_95_status is not null) as k95,
       count(*) filter (where o.diesel_status = true) as adt,
       count(*) filter (where o.diesel_status is not null) as kdt,
       count(*) filter (where o.queue_level = 'high') as q,
       count(*) as marks,
       count(*) filter (where o.fuel_92_status = true or o.fuel_95_status = true
                             or o.diesel_status = true) as selling
from public.observations o
join public.stations s on s.id = o.station_id
where s.lat >= 44.60 and s.lat <= 44.85 and s.lon >= 37.55 and s.lon <= 38.05
group by 1;
alter view public.city_fuel_hourly set (security_invoker = true);

-- дневные агрегаты событий (для кардиограмм "Неделя"/"Месяц")
create or replace view public.city_daily_events as
select date_trunc('day', detected_at) as day,
       count(*) filter (where event_type = 'fuel_disappeared') as dis,
       count(*) filter (where event_type = 'fuel_restored') as res
from public.events group by 1;
alter view public.city_daily_events set (security_invoker = true);

-- учебная выборка: только верифицированные с известной ошибкой.
-- ВНИМАНИЕ: новые колонки только в конец списка (иначе 42P16)
create or replace view public.prediction_training as
select id, station_id, fuel_type, from_time, to_time,
       confidence, prediction_source, based_on_observations, based_on_stations,
       target_date, created_at, actual_restore_at, error_minutes, features,
       baseline_error_minutes
from public.predictions
where is_verified = true and error_minutes is not null;
alter view public.prediction_training set (security_invoker = true);

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
    and (queue_size is null or queue_size in ('small','medium','large','huge'))
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

- **GdeBenz** (основной): отметки водителей, статусы, цены, очереди. Текстовых комментариев в открытом API нет — шаг парсинга комментариев убран из коллектора в v4, таблица `comments` спит.
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
| 16.09.2026 день | Тепловая матрица 4×24 + кардиограмма День/Неделя/Месяц + мультивыбор отметок + дайджест 6 метрик + защищённая загрузка (try/catch per view) + честные пустые состояния |
| 17.09.2026 | Починка кардиограммы Неделя/Месяц + отладочная плашка dbgShow; шапка v2 (двуцветный вордмарк, слоган, иконка со скоростью); обучающий контур v1.2 (миграция, features-снапшот, режим города); верификатор v1.2 (величина ошибки); предиктор v1.3 (k-NN по эпизодам, очередные события); блок «Почему такой прогноз»; collector v4 без парсинга комментариев (прогон 58 с → ~10 с) |
| ночь 17→18.09.2026 | Предиктор v1.4 (гейт молчащих станций по data_freshness_minutes > 7 сут); selling-нормировка очередей в вьюхах и на сайте; «Куда ехать» с гейтом свежести и меткой «· топливо есть»; baseline_restore_at/baseline_error_minutes + блок TRAINING DATA в верификаторе |