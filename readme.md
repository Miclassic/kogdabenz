# ⛽ КогдаБенз — «когда лучше заправиться?»

Система временнóго прогнозирования для водителей юга России
(домашняя база — Новороссийск; с волны 1 — весь Кубань+Адыгея; позиционирование — «КогдаБенз · юг»).
Мы не копируем чужие карты наличия топлива — мы отвечаем на вопрос **«КОГДА»**:
когда на конкретной АЗС вероятно вернётся топливо и когда лучше заехать.

> Цель: собрать историю изменений АЗС → найти закономерности → предсказать окно
> пополнения → проверять прогнозы на фактах → улучшать точность.

---

## Как работает система

```
GdeBenz API (домашняя рамка: Новороссийск+Геленджик+Анапа+Крымск, ~137 АЗС)
      + донор-рамка "Кубань+Адыгея" (~698 АЗС, region='kuban')
        ↑ каждые 10 минут будит cron-job.org → workflow_dispatch
collector.js (GitHub Actions, чистый fetch, v5.1):
  дом: станции → наблюдения → события (топливо/очереди, gap-детектор, фильтр противофазы)
  донор: станции → экономная запись (смена статуса / heartbeat 1ч / первая встреча)
  → народные отметки user_feedback → события → уборка наблюдений >30 дней
  → Telegram-лента «живая хроника» (с учётом тихого режима bot_meta.notify)
  v5.1: отказоустойчивость к источнику — 429/503/сеть = upstream-ошибка: мягкий выход 0
  + троттлинг алерта «источник недоступен» ≤1 раза в час (bot_meta.upstream_alert)
  + джиттер старта ≤45 сек (не стучим синхронно с волнами чужих атак)
        ↓
Supabase: stations / observations / events / predictions /
          user_feedback / bot_meta + вьюхи (security_invoker)
        ↓
predictor.js v1.8:
  рамка ВСЕГО юга (дом + донор): прогнозы и очереди по всем станциям
  медиана±σ по Москве, пулинг own→brand→city, модель длительности дефицита,
  k-NN по эпизодам "исчезло→вернулось" (порог ≥8, иначе медиана-фолбэк),
  v1.7: день недели в k-NN — круговое расстояние (0..3 дня) + класс будни/выходные,
  v1.8: калибровка уверенности по таблице bot_meta.calibration_table
  (нет таблицы / старше 21 дня / битая → сырая уверенность, фолбэк),
  conf_raw в features (сырая уверенность до калибровки — метка для калибратора),
  features-снапшот (час/день, возраст дефицита, очередь+тренд+queue_age_min,
  регион, соседи без 95, возвраты/исчезновения, режим, k-NN, station_state),
  режим региона (NORMAL/LOCAL/CITY/DEEP_SHORTAGE/RECOVERY/UNKNOWN),
  гейт молчащих станций, baseline_restore_at, прицел target_date "сегодня"/"завтра"
        ↓
verifier.js v1.2 (02:10 MSK, ежедневно):
  оценивает вчерашние прогнозы по фактам → SUCCESS/MISS → is_verified
  + величина ошибки: actual_restore_at, error_minutes, baseline_error_minutes
  + TRAINING DATA в логе (MAE/медиана/p90 + bias + разбивки по режиму/источнику/k-NN/часу)
  + вызов logTrainingData на обоих путях (пустой прогон тоже печатает)
        ↓
calibrator.js v3 (02:25 MSK, сразу после верификатора):
  свежесть: верифицированные строки за 14 дней (фолбэк 30 при нехватке),
  ворота: ≥30 строк И ≥10 SUCCESS И разброс бинов ≥15 п.п.,
  квантильные бины (≥5 строк, ≤8 бинов) + изотония PAVA,
  таблица → bot_meta.calibration_table (JSON-строка);
  ворота не пройдены → таблица САМОудаляется, предиктор на сырой уверенности
        ↓
prediction_training (вьюха): верифицированные прогнозы с features и ошибкой
        ↓ (измерение; shadow-сравнение версий по model_version — следующий шаг)
digest.js (08:00 MSK, ежедневно): сводка за 24 ч в Telegram
bot.js (каждые 5 мин): читает обновления Telegram, отвечает на кнопки /status /predict /digest /quiet /loud
        ↓
Сайт (GitHub Pages, v2.8 + PWA): персонален по геолокации пользователя:
  список/чипы/плашка/кардиограмма по умолчанию = город пользователя (CITY_BOXES, 9 городов),
  весь юг — карта и тумблер "город / весь юг"; region_* вьюхи с фильтром city;
  кардиограмма с динамической линейкой процентов слева;
  карта спроса (кластеры/пины/зоны с пульсом, градиентные пины, таблички, вылетающие чипы,
  кольцо действий, быстрая отметка с подтверждением);
  народный консенсус на карте (2 голоса красят пин, 3 — «народ подтвердил»,
  конфликт мнений — оранжевый пин с «?»; приоритет источника);
  прогноз очереди в карточке («Очередь вероятна: HH:MM–HH:MM · N%» + why-pop);
  тепловая матрица + пульс + метрики (покрытие, возраст очереди, цены в карточке);
  панель «Наша точность прогнозов» + «Почему такой прогноз» + «Куда ехать» с расстоянием;
  карточка «Помощь» + приветственное окно первого захода + кнопка «Попробовать снова»;
  PWA: manifest + service worker (статика cache-first, API network-first, кэш только ok),
  установка на домашний экран; офлайн-режим: снимок kbCache + плашка «Нет связи —
  данные на ЧЧ:ММ» + отметки в локальную очередь fbQueue с автоотправкой
```

---

## Состав репозитория

| Файл | Роль | Статус |
|---|---|---|
| `collector.js` | Сборщик v5.1: дом + доноры, экономная запись доноров (heartbeat **1ч** + смены), лукбэк 24ч, живая лента, gap-детектор, фильтр противофазы, народные отметки, уборка; v5.1 — upstream-отказоустойчивость (мягкий выход 0, троттлинг алерта ≤1ч, джиттер) | ✅ прод |
| `predictor.js` | Предиктор v1.8: рамка всего юга, пулинг own/brand/city, модель дефицита + k-NN (v1.7: день недели — круговое расстояние + класс будни/выходные), v1.8: применение калибровки + `conf_raw` + `model_version v1.2`, снапшот features, режим региона, гейт молчащих, `baseline_restore_at` | ✅ прод |
| `verifier.js` | Верификатор v1.2: величина ошибки + TRAINING DATA с bias и разбивками; logTrainingData вынесена в функцию и вызывается на обоих путях | ✅ прод |
| `calibrator.js` | Калибратор уверенности v3: свежесть 14/30 дней, ворота ≥30 строк / ≥10 SUCCESS / разброс ≥15 п.п., бины + PAVA, таблица в `bot_meta.calibration_table`, самоудаление таблицы при провале ворот | ✅ прод |
| `probe.js` | Разведка покрытия GdeBenz по рамкам (без записи в базу): станции / с топливом / с ценами / с очередями | ✅ прод |
| `digest.js` | Утренний дайджест за 24 ч | ✅ прод |
| `bot.js` | Бот с кнопками: отчёты и тихий режим (серверлесс, без сервера) | ✅ прод |
| `index.html` | Сайт v2.8: всё из v2.7 + кнопка «Попробовать снова»; народный консенсус на карте (2/3 голоса, конфликт-пин); прогноз очереди в карточке; sheet-scroll (лечение чёрных углов); пауза пульса зон под шторкой; PWA (manifest, sw.js); офлайн-режим (kbCache, плашка, fbQueue) | ✅ прод |
| `manifest.json` | PWA-манифест: имя, тема, standalone, SVG-иконка (any maskable), относительные `start_url`/`scope` | ✅ прод |
| `sw.js` | Service worker: статика cache-first, API network-first, кэш только ok-ответов; `CACHE_VERSION` — механизм обновления (поднимать при любых правках index.html/manifest.json) | ✅ прод |
| `.github/workflows/collect.yml` | dispatch + «Telegram on failure» | ✅ прод |
| `.github/workflows/predict.yml` | dispatch предиктора | ✅ прод |
| `.github/workflows/digest.yml` | dispatch дайджеста | ✅ прод |
| `.github/workflows/verify.yml` | dispatch верификатора | ✅ прод |
| `.github/workflows/calibrate.yml` | dispatch калибратора (native schedule как резерв, основной будильник — cron-job.org) | ✅ прод |
| `.github/workflows/bot.yml` | dispatch бота (каждые 5 мин) | ✅ прод |
| `.github/workflows/probe.yml` | dispatch разведки покрытия (по требованию) | ✅ прод |
| `README.md` | Этот документ | ✅ |
| `statistics.js`, `confidence.js`, `handler.js`, `comments.js`, `events.js`, `gdebenz.js`, `scheduler.js`, `setup.js` | Черновики-спецификации этапов E/F (`confidence.js` — легаси-дубль верификатора, не используется) | 📐 затем в `legacy/` |

Внешние сервисы:
- **cron-job.org** — основной будильник: каждые 10 минут — `collect`, каждые 5 минут — `bot`, ежедневно 06:00 MSK — `predict`, ежедневно 02:10 MSK — `verify`, ежедневно 02:25 MSK — `calibrate`, ежедневно 08:00 MSK — `digest`. Все через GitHub API `workflow_dispatch`. PAT fine-grained: Actions Read and write, только этот репозиторий.
- **Telegram-бот «КогдаБенз Алерт»** — живая хроника событий с человеческой формулировкой и выводом для водителя, 🔮 первые прогнозы, 🚨 аварии,  дайджест, кнопки-отчёты, тихий режим.
- Родной GitHub `schedule` на этом репозитории **не срабатывал ни разу** — внешний будильник считается основным.

---

## База данных (Supabase)

| Таблица | Что хранит |
|---|---|
| `stations` | Реестр АЗС (external_id = osm_id, brand, address, lat/lon, source, **region**, fuels_meta) |
| `observations` | Снимки статусов каждые 10 мин (+ data_freshness_minutes, queue_level, цены price_92/95/diesel); для доноров — экономно (смены/heartbeat 1ч) |
| `events` | Изменения: топливные, очередные, народные |
| `predictions` | Окна прогнозов + prediction_source + based_on_stations + expected_restore_at + baseline_restore_at + target_date + result/is_verified + features (jsonb-снапшот признаков, включая `conf_raw`) + model_version + actual_restore_at + error_minutes + baseline_error_minutes |
| `user_feedback` | Структурированные народные отметки: feedback_type + fuel_type + queue_size + comment_text + device_id |
| `bot_meta` | Состояние бота и сервиса (update_offset, notify) + `upstream_alert` (время последнего алерта о недоступности источника) + `calibration_table` (JSON-строка таблицы калибровки) — только service_role |
| `comments` | Текстовые комментарии (источник не даёт — таблица спит; шаг парсинга убран в collector v4) |

Формат `bot_meta.calibration_table` (value — JSON-строка, переживает и jsonb, и text):
```json
{
  "v": 2,
  "built_at": "2026-09-22T23:25:00.000Z",
  "window_days": 14,
  "n": 1967,
  "successes": 26,
  "points": [[0.37, 0.0], [0.41, 0.03], [0.46, 0.03]]
}
```
`points` — мононотонная (PAVA) таблица «сырая уверенность → фактическая доля попаданий»; предиктор интерполирует между точками и зажимает в 0.05–0.95.

**Вьюхи (обход лимита Supabase REST в 1000 строк + безопасный RLS-режим):**

Региональные (city-измерение: `'south'` + 9 городов боксами, через `cross join lateral (values ...)`):
- `region_hourly` — почасовой пульс (marks, queue_marks, avail95, known95, selling) — кардиограмма «День» и теглайн
- `region_fuel_hourly` — 4 ряда тепла (АИ-92/95/ДТ/Очереди) + selling + `knownany` (покрытие источника) — тепловая матрица, чипы, плашка
- `region_events` — топливные события города/региона — колонны кардиограммы, дайджест-панель
- `region_daily_events` — дневные агрегаты исчезновений/возвратов — кардиограммы «Неделя/Месяц»

Домашние (bbox Новороссийска, legacy + ценовые метрики):
- `station_counts`, `station_hourly` — по станции
- `city_hourly`, `city_fuel_hourly` (+selling, +knownany), `city_events`, `city_daily_events`
- `city_price_hourly` — почасовые медианы цен по трём топливам + min/max АИ-95 + покрытие ценами
- `station_last_price` — последние известные цены станции (дельты «к городу» в карточке)
- `city_queue_episodes` — эпизоды очереди gaps-and-islands (начало/конец, ended_at null = стоит сейчас): возраст очереди на пине и в карточке, медиана очереди; **также питает прогноз очереди в карточке АЗС**

Учебная:
- `prediction_training` — верифицированные прогнозы с `error_minutes` и `features` (вход измерений и тюнинга)

Все вьюхи установлены с `security_invoker = true` — RLS-политики применяются под маской запросившего, а не создателя вьюхи.

**Белые списки** (check-constraints):
- `events_event_type_check`: fuel_disappeared, fuel_restored, fuel_available, fuel_unavailable, possible_delivery, queue_high, queue_low, queue_appeared, queue_gone
- `user_feedback_insert` (RLS policy): feedback_type/fuel_type/queue_size только из списка чипсов, device_id обязателен

Правило: новый тип события = сначала расширить constraint, потом писать код.

---

## Что сделано (статус на 22.09.2026)

- [x] Этапы 1–4: API GdeBenz, коллектор на Actions, история наблюдений, gap-детектор + фильтр противофазы
- [x] Безопасность: service_role только в секретах; RLS везде; вьюхи security_invoker; белый список user_feedback; аноним = select
- [x] Этап 5: предиктор v1 → v1.1 (пулинг own→brand→city, модель длительности дефицита, expected_restore_at, всё по Москве)
- [x] Первый 🟢 fuel_restored (15.09, 12:11) и первые прогнозы (15.09, 21:31, brand-пул)
- [x] Этап 6/D: верификатор v1 с прицелом `target_date`; сайт v2; пульс города; бот v2; бренды-логотипы; дайджест 08:00
- [x] Тепловая матрица 4×24 + кардиограмма День/Неделя/Месяц + мультивыбор отметок + дайджест-панель + защищённая загрузка (try/catch per view) + честные пустые состояния + чипы «Сейчас · АИ-95 есть» (16.09)
- [x] Обучающий контур v1.2 + верификатор v1.2 (величина ошибки) + предиктор v1.3 (k-NN) + блок «Почему такой прогноз» + collector v4 без комментариев (17.09)
- [x] Предиктор v1.4 (гейт молчащих > 7 сут) + selling-нормировка очередей + «Куда ехать» с гейтом свежести + baseline-сравнение + TRAINING DATA + фильтр/сортировка + живая лента + режим UNKNOWN ночью + logTrainingData как функция (ночь 17→18.09)
- [x] Волна 1: донор Кубань+Адыгея (~698 станций), `stations.region`, экономная запись, вьюхи city_events/city_daily_events с bbox (ночь 17→18.09)
- [x] Карта спроса: MapLibre + OpenFreeMap positron, «чистая бумага», зоны/кластеры/пины с тап-полётом и разлётом пинов (18.09)
- [x] Сайт v2.5 (ночь 18→19.09): геолокация и точка «я здесь»; зоны v2; палитра пинов по топливу + градиентные пины; таблички названий с логотипом бренда; вылетающие чипы; кольцо действий в стиле The Sims; пузырь быстрой отметки с подтверждением; метрики ① цены ② покрытие ③ возраст очереди; шапка панели списка; легенда карты в две строки
- [x] Сайт v2.6 + предиктор v1.5 (19.09): панель «Наша точность прогнозов»; стабильность кластеров при панорамировании; «Куда ехать» с расстоянием; `queue_age_min` в features; последнее спокойное окно + совет «очередь HH:MM»
- [x] Расширение на весь юг → сайт v2.7 (19.09 вечер): collector v5 heartbeat доноров 1ч; predictor с рамкой всего юга; 4 region-вьюхи с city-измерением; персональный город по геолокации (CITY_BOXES 9 городов); шапка «Рядом | Помощь» + супрафикс «юг»; Q&A-карточка «Помощь» + приветственное окно; хотфикс потерянной скобки `scopeIds()`
- [x] **Сайт v2.8, часть 1 (20.09):** кнопка «Попробовать снова» при ошибке загрузки; **народный консенсус на карте** — голоса разных `device_id` за 60 мин: 1 голос = чип «· народ», 2 = окраска пина, 3 = «народ подтвердил», одновременные «есть» и «нет» = оранжевый пин с «?» и чип «разные мнения»; приоритет источника (народ красит пин только когда источник молчит обо всех топливах); консенсус НЕ пишется в observations; **прогноз очереди в карточке** — медианное окно ±σ по часовым отметкам очереди (своих событий <3 → город), why-pop «Прогноз очереди»
- [x] **Сайт v2.8, часть 2 + collector v5.1 + predictor v1.7 (21.09):** sheet-scroll (внешняя шторка overflow:hidden + внутренний скроллер — лечение артефакта чёрных углов мобильного Chrome на скруглённом скроллящемся слое); пауза пульса зон при открытой шторке и на других панелях; **PWA** (manifest.json + sw.js: статика cache-first, API network-first, установка на домашний экран, standalone); collector v5.1 upstream-отказоустойчивость (429/503/сеть = мягкий выход 0 + троттлинг алерта ≤1ч через `bot_meta.upstream_alert` + джиттер ≤45с); predictor v1.7 (день недели в k-NN: круговое расстояние + класс будни/выходные)
- [x] **Офлайн-контур + калибровка (22.09):** офлайн-режим сайта — снимок успешной загрузки в `localStorage.kbCache`, при падении загрузки показ снимка с плашкой «Нет связи — показываем данные на ЧЧ:ММ…», отметки без сети в `localStorage.fbQueue` с автоотправкой при первом успешном загрузе, снимок не перезаписывается офлайн-данными, loadPulse-catch не затирает тепло/события из снимка (`if (!offlineMode)`); гуманизация текстов ошибки; **calibrator.js v1→v3** + `calibrate.yml` + cron 02:25 MSK: починка ошибки выжившего (знаменатель — все закрытые окна, MISS без возврата = честный промах), свежесть 14/30 дней, ворота ≥30 строк / ≥10 SUCCESS / разброс бинов ≥15 п.п., изотония PAVA, самоудаление таблицы при провале ворот; predictor v1.8 (применение таблицы, `conf_raw` в features, `model_version v1.2`); sw.js: кэш только ok-ответов, `CACHE_VERSION` v3
- [ ] Shadow-сравнение версий модели по `model_version` (прод = лучшая по медиане |error|)
- [ ] Волна 2: Ростов/Ставрополь (~1575 станций) — после замера выхода эпизодов с Кубани за неделю
- [ ] Волна 3: Москва/Новосибирск — доноры режима NORMAL под калибровку
- [ ] `city_queue_episodes` → region-измерение (возраст очереди для персонального города, не только домашнего бокса)
- [ ] Очереди этап 2: народные события queue_high/queue_appeared в почасовом q; модельная оценка очереди в дефицит с явной подписью «оценка»
- [ ] Поправка смещения ETA (bias +101 мин по TRAINING DATA) — после накопления измеренных строк вне дефицита
- [ ] Метрика ④ сходимость народных отметок с источником и метрика ⑤ цензурирование в дайджесте — заморожены решением продукта
- [ ] **MAU-статистика перед рекламой на kogdabenz.ru**: собственный счётчик (таблица site_hits) + события кликов; дашборд MAU/удержание/источники прихода
- [ ] **TWA (Bubblewrap)** — APK без бейджа Chrome и вход в Google Play: после подъёма kogdabenz.ru с `.well-known/assetlinks.json`
- [ ] Этап 7/F: модель v2 (триггер очереди с лагом, загруженность, биржевой фон)
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
7. Прогноз прицеливается на дату (`target_date`); верификатор трогает только вчерашние цели.
8. Официальные городские сводки не используем; Яндекс/2GIS/банки не парсим (ToS, антибот) — данные берём легально: GdeBenz API + своя толпа.
9. Очередь — опережающий сигнал: появилась раньше отметок топлива.
10. Фильтр противофазы: дизель и бензин в противофазу за один снимок = артефакт состава отметок, дизельный флаг выбрасываем.
11. Новый тип события → сначала белый список constraint, потом код.
12. Помним про лимит Supabase REST (1000 строк): агрегаты считаем вьюхами, а не выгрузкой сырых строк.
13. Вьюхи — всегда `security_invoker = true`, чтобы RLS работал сквозь них.
14. Народные отметки с структурой → в базе только значения из белого списка (RLS policy).
15. Серверлесс где возможно: бот без сервера, на cron-job.org + Supabase meta-таблица.
16. Отказоустойчивость сайта: каждый внешний запрос к вьюхе в своём try/catch; отрисовка блоков не падает от одной упавшей вьюхи.
17. Пустые состояния видимы: нет данных → серая плашка с объяснением, не «пусто на белом» и не суррогат ради плотности.
18. Мультивыбор в UI: несколько фактов одновременно — отправляем массивом.
19. Обучение только на верифицированных исходах: верификатор — единственные ворота обучения.
20. `CREATE OR REPLACE VIEW`: новые колонки только дописываются в конец — иначе ошибка 42P16.
21. Изменения модели — аддитивно с фолбэком на малых данных: k-NN при поддержке ≥8 эпизодов, иначе старая медиана.
22. Измерение раньше усложнения: сначала error_minutes/baseline_error_minutes и TRAINING DATA, потом новые модели; тяжёлое ML — не раньше сотен верифицированных прогнозов.
23. Экономная запись донор-наблюдений: для `region` not null — только смены/heartbeat 1ч/первая встреча.
24. Городские сводки домашнего бокса — из city-вьюх; региональные/персональные — из region-вьюх с фильтром `city`.
25. Карта спроса: чужие слои скрываем рантаймом после `load`; кластеры считаем на мировых координатах по всем станциям, рисуем только центры в кадре; тап по маркерам слушаем в capture-фазе document.
26. **Сайт персонален по геолокации**: список, поиск, чипы, плашка, «Куда ехать», теглайн и кардиограмма по умолчанию = город пользователя (`CITY_BOXES` → `cityStationList()`); весь юг — через карту и тумблер скоупа.
27. Панели сайта не скроллятся вниз (кроме списка «АЗС города»): новые сущности — только оверлеи или уплотнение существующих блоков.
28. Быстрые действия на карте работают без открытия карточки; любая отправка народной отметки обязана иметь видимое подтверждение.
29. Палитра едина: один цвет одного смысла во всех сущностях карты (пины, полоса кластера, вылетающие чипы, легенда).
30. Прозрачности и толщины GL-слоёв задаём обычными числами из JS (рампа по зуму + пульс): составные выражения с `interpolate(zoom)` MapLibre применяет непредсказуемо.
31. Анимации маркеров не перебивают центрирующий transform: отдельные keyframes с translate внутри.
32. Советник «Куда ехать» учитывает расстояние (штраф min(25, км × 1.5)) и советует только станции со свежими данными ≤6 ч и ненулевым топливом.
33. Приветственное окно — один раз на устройство (`localStorage.seenHello`); карточка «Помощь» — простым языком, без технических терминов.
34. После серии ручных правок на мобильном — проверять целостность файла (обрыв скрипта или потерянная скобка = сайт в заглушках без ошибок в консоли элементов).
35. **Любая правка `index.html` или `manifest.json` → поднять `CACHE_VERSION` в `sw.js`**: статика отдаётся cache-first, иначе устройства останутся на старой копии сайта (кейс 22.09: новый код лежал в репозитории, телефон показывал старую страницу).
36. Service worker кэширует **только ok-ответы**: 503/ошибки не должны консервироваться и возвращаться как «данные».
37. Народный консенсус: приоритет источника (народ красит пин только когда источник молчит обо всех топливах); голоса считаем по разным `device_id` за 60 минут; 2 голоса — окраска, 3 — «народ подтвердил», одновременные «есть»/«нет» — оранжевый пин с «?» и чип «разные мнения»; консенсус не пишется в `observations` (мягкий слой карты).
38. Шторка: внешняя `.sheet` — скругления и `overflow:hidden` без прокрутки; контент скроллится во внутренней `.sheet-scroll` (лечение артефакта чёрных углов мобильного Chrome на скруглённом скроллящемся слое).
39. Пульс зон карты останавливается при открытой шторке/приветственном окне и на панелях кроме карты: непрерывная перерисовка WebGL под подложкой даёт мерцание по краям экрана.
40. Ворота калибровки: ≥30 верифицированных строк в окне свежести (14 дней, фолбэк 30), ≥10 SUCCESS, разброс бинов ≥15 п.п.; ворота не пройдены → таблица самоудаляется, предиктор на сырой уверенности; знаменатель калибровки — **все закрытые окна** (MISS без возврата = честный промах, а не цензура).
41. Офлайн: снимок пишется только успешной загрузкой и не перезаписывается офлайн-данными; отметки без сети → `fbQueue` с автоотправкой; ошибка загрузки без снимка — дружелюбная плашка с кнопкой «Попробовать снова», не технический текст.
42. Коллектор: недоступность источника (429/503/сеть) = мягкий выход 0 + троттлинг алерта ≤1 раза в час (`bot_meta.upstream_alert`); exit 1 и красный workflow — только собственные баги коллектора.

---

## Запуск и проверка

- Ручной прогон: Actions → любой workflow → Run workflow.
- Норма collect: `Станций в ответе: ~137` + `Донор kuban: станций ~698` + `Наблюдений записано: дом 137 + доноры N`; при недоступности источника — `⚠️ Источник недоступен: …` и **зелёный** workflow (мягкий выход 0), алерт в Telegram не чаще раза в час.
- Норма predict: `Контекст региона: … режим …`, `Эпизодов дефицита для k-NN: N`, `4.9) Читаю таблицу калибровки уверенности…` + одно из: `Таблицы калибровки ещё нет — сырая уверенность` / `Калибровка применится: таблица от … по N проверенным прогнозам`; далее `Создано: N, обновлено: N, пропущено: N, молчащих станций (>72ч): N`.
- Норма verify: ночью построчные ✅ SUCCESS / ❌ MISS с величиной ошибки и TRAINING DATA (пустой прогон тоже печатает).
- Норма calibrate: `=== КАЛИБРАТОР v3 ===` + `Окно 14 дн: строк N, попаданий M`; ворота не пройдены — `Мало попаданий (M < 10)… Таблица удалена…`; пройдены — строки бинов `сырая 0.46 → факт 12% (n 40)` и `✅ Таблица калибровки записана (…)`.
- Норма probe: `=== РАЗВЕДКА ПОКРЫТИЯ GdeBenz ===` + по строке на каждую рамку.
- Норма digest: одно сообщение в Telegram вида «🌅 КогдаБенз · дайджест за сутки…».
- Норма bot: `/start` → клавиатура кнопок → «📊 Сводка города» → отчёт о дефицитах и очередях.
- Норма сайта: список и чипы показывают город пользователя; тумблер «город / весь юг» перезагружает кардиограмму/тепло/чипы; «Помощь» открывает Q&A-шторку; приветственное окно один раз; «Куда ехать» — станция города с километрами; карта показывает весь юг кластерами и пинами; народный консенсус красит пины молчащих станций по правилам 2/3/конфликт; в карточке — полоса «Очередь вероятна: …»; PWA ставится на домашний экран (меню → «Установить приложение»), открывается standalone; при падении загрузки со снимком — оранжевая плашка «Нет связи — показываем данные на ЧЧ:ММ ДД.ММ», отметки без сети дают подтверждение «сохранена, уйдёт автоматически».
- SQL-самопроверка:
```sql
select event_type, count(*) from events group by event_type;
select count(*) filter (where timestamp > now() - interval '1 hour') as за_час,
       count(*) as всего from observations;
select region, count(*) from stations group by 1;
select target_date, result, count(*) from predictions group by 1,2 order by 1 desc;
select key, value from bot_meta;
-- калибровка:
select value from bot_meta where key = 'calibration_table';
-- обучение:
select count(*) from prediction_training;
select count(*) filter (where error_minutes is not null) as с_ошибкой,
       count(*) filter (where baseline_error_minutes is not null) as с_baseline
from predictions where is_verified;
-- регион/город:
select city, count(*) from region_hourly group by 1 order by 2 desc;
select city, count(*) from region_fuel_hourly group by 1 order by 2 desc;
select count(*) from stations where lat between 44.60 and 44.85 and lon between 37.55 and 38.00;
-- для сайта (домашние метрики):
select count(*) from city_price_hourly where hour > now() - interval '7 days';
select count(*) from city_queue_episodes where started_at > now() - interval '3 days';
```
- Table Editor показывает время в UTC; новороссийское = +3.

---

## Безопасность

- Секреты GitHub: `SUPABASE_URL`, `SUPABASE_KEY` (service_role), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- В клиентский код (`index.html`) — только anon-ключ.
- PAT для cron-job.org: fine-grained, Actions Read and write, один репозиторий; ротация при любой утечке.
- Антиспам народных отметок: ≤3 с устройства за 30 минут (localStorage) + RLS-белый список типов/топлива/размеров очереди.
- Вьюхи `security_invoker` = RLS применяется под маской запросившего.
- `bot_meta` доступна только service_role — состояние бота, троттлинг алертов и таблица калибровки не торчат наружу.
- `probe.js` не требует секретов: только публичный GdeBenz с паспортом браузера.
- Будущая MAU-телеметрия: без персональных данных, геопозиция только с явного согласия, session id случайный.
- PWA: service worker кэширует только ok-ответы; инвалидация кэша — только подъёмом `CACHE_VERSION`.

---

## Troubleshooting

| Симптом | Причина / лечение |
|---|---|
| `GdeBenz ответил 502/403` | Защита от ботов или чих: BROWSER_HEADERS + 3 повтора уже в коде; план Б — cookie в секреты |
| «сборщик упал!» спамит каждые 10 минут во время чужой DDoS на источник | upstream-ошибки (429/503/сеть) теперь = мягкий выход 0 + алерт ≤1 раза в час (`bot_meta.upstream_alert`); красный workflow — только собственные баги |
| `violates check constraint events_event_type_check` | Новый тип события не в белом списке → расширить constraint |
| Dispatch от cron-job: `404 Not Found` | Workflow-файл лежит не в `.github/workflows/` (классика мобильного GitHub: папка-двойник) |
| `ReferenceError: X is not defined` после заплатки | Объявление переменной внутри блока `if` — вынести на уровень использования |
| `SyntaxError: Unexpected end of input` после серии заплаток | Разбаланс фигурных скобок при ручной вставке кусков — заменить файл целиком на выверенный |
| Сайт стоит в заглушках без ошибок в элементах | Скрипт оборван или функция не закрыта (кейс: потеряна `}` у `scopeIds()`); проверить хвост файла, восстановить закрытие |
| Сайт показывает старую версию после коммита | Service worker cache-first: поднять `CACHE_VERSION` в `sw.js`; без этого устройства не получат новый index.html |
| 503 «консервируется» и отдаётся без сети | sw.js кэшировал не-ok ответы; теперь в кэш идёт только `response.ok` |
| 404 «There isn't a GitHub Pages site here» | Pages не опубликован: Settings→Pages (Source: branch `main` + `/ (root)`), видимость репозитория Public, `index.html` в корне на месте |
| Чёрные «клинья» по углам шторки на мобильном | Скругления на скроллящемся слое (GPU-артефакт): скролл вынесен во внутренний `.sheet-scroll`, внешняя `.sheet` с `overflow:hidden` |
| Мерцание по краям экрана под шторкой | Пульс зон перерисовывал WebGL 15 раз/сек под blur-подложкой: пульс останавливается при открытой шторке и вне панели карты |
| Офлайн: тепло серое, «Пик спроса —» при живом снимке | loadPulse-catch затирал `fuelHourly`/`dailyEvents` из снимка: охрана `if (!offlineMode)`; ранний `saveCache()` из `start()` убран (не перезаписывать хороший снимок пустым) |
| Уверенность скакнула в 95%, затем в 5% | Калибровка: ошибка выжившего (знаменатель только строки с возвратом) → знаменатель все закрытые окна; плоская таблица дефицита (0–3%) → ворота разброса ≥15 п.п. + самоудаление таблицы |
| «Отслеживаем 0» / «топливо видно: 0 из 0» | `localIdsGlobal` посчитан до присвоения `allStations` в `start()` — считать как `stations.map(s => s.id)` после загрузки |
| Чипы/плашка показывают южные цифры вместо городских | Циклы `renderHero`/`renderNow`/`updateMapPlate`/`toggleCovPop` идут по `localIdsGlobal`; должны идти по `citySet = new Set(cityStationList().map(s => s.id))` |
| Кардиограмма пустая в обоих скоупах | Вьюха `region_hourly` не создана или city-фильтр не матчится: проверить `select city, count(*) from region_hourly group by 1` |
| Строка «Очереди» серая, линия спроса нулевая после патча | Новая колонка вьюхи (`selling`/`knownany`) не добавлена в явный `select=` запроса сайта — дописать |
| `42P16 cannot change name of view column` при пересоздании вьюхи | В `CREATE OR REPLACE VIEW` новые колонки дописываются только в конец |
| Очереди «всё зелёное» при живых пробках | Знаменатель «все станции» размывает очередь дефицита; очереди нормируются на `selling` |
| Кардиограмма: шкала до 800% | Норма в дефицит: очереди у станций без топлива дают queue_marks > selling; линейка динамическая |
| «Куда ехать» ведёт на АЗС с «нет данных» | Гейт `data_freshness_minutes ≤ 360` + приоритет «топливо есть сейчас» + ненулевой статус топлива |
| «Куда ехать» ведёт на дальнюю АЗС | Штраф расстояния min(25, км × 1.5) + городской скоуп советника |
| «Молчащих станций: 28 из 29» после гейта | Гейт только по `data_freshness_minutes > 7 сут` (возраст строки непригоден в дефицит) |
| `prediction_training = 0` сразу после миграции | Норма до первого verify новым кодом (02:10 MSK) |
| Цензурировано: 100% верифицированных / панель точности 0/N | В дни глубокого дефицита возвраты редки; MISS без факта = `error_minutes = null`; это сигнал, не поломка; панель оживёт при 3+ измеренных |
| `regime:UNKNOWN` в TRAINING DATA | Норма для ночных часов с `known95 = 0` |
| TRAINING DATA не печатается в пустом прогоне verify | Оставить только вызов `await logTrainingData()` в двух местах |
| «Доноры 0» между часовыми границами | Норма при heartbeat 1ч: доноры пишутся на часовой границе и при сменах |
| Приветственное окно не показывается | `localStorage.seenHello` уже установлен; для теста удалить ключ |
| Бейдж Chrome на иконке PWA | Системная метка веб-приложения; убирается только TWA/APK с собственным доменом и `assetlinks.json` |
| Легенда кардиограммы уезжает под кнопки | Уплотнение панели 1 + `overflow:hidden` на `.mini-graph`; при нехватке высоты масштабируется svg |
| Тепловая матрица серая / кардиограмма пустая (домашний скоуп) | Вьюха `region_fuel_hourly` не создана или фильтр `city=novorossiysk` не матчится с боксом |
| Кардиограмма Неделя/Месяц: `b.getFullYear is not a function` | `sameDay(nowD, b)` получил объект-бакет вместо даты: правильно `sameDay(nowD, b.t)` |
| Карта не загружается / белое пятно | Тайлы OpenFreeMap — внешний хост, из РФ может идти медленно; заменить URL стиля одной строкой в `ensureMap` |
| Тап по квадрату кластера не летит | Document-детектор в capture-фазе с `preventDefault()` на pointerdown по маркеру и задержкой полёта ~120 мс после pointerup |
| Пины плавают во время жестов панорамирования | CSS `.maplibregl-marker` с `transition:none !important; animation:none !important; will-change:transform` — не перебивать |
| Кластеры прыгают при панорамировании и меняют цифру | Ячейки считать по всем станциям, рисовать только центры в кадре |
| Чипы кольца «съезжали» при появлении | У кольца свои keyframes mPopRing с translate внутри |
| Синие чипы кольца не реагировали на тап | Чипы владеют жестом сами (stopPropagation pointerdown/pointerup), действие на click |
| Плашка/полоса рвёт слова при переносе | Неразрывные сегменты `.ps-wrap` / `.ps`: перенос только между смысловыми блоками |
| Быстрая отметка отправлялась «в тишину» | Подтверждение обязательно: пузырь показывает «Спасибо 🙏» (или «нет связи — сохранена») и сам закрывается |
| Чип покрытия всегда «0 из N» | `knownany` не добавлен в явный `select=` запроса к `region_fuel_hourly` — дописать |
| Многоточие в ячейках карточки | `text-overflow: ellipsis` режет длинный хвост; цена и дельта разнесены на две строки |

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

-- Волна 1: регион станции (null = домашняя рамка, 'kuban' = донор Кубань+Адыгея)
alter table public.stations add column if not exists region text;
create index if not exists idx_stations_region on public.stations (region);

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

-- домашние вьюхи (bbox Новороссийска): пульс, тепло, события, дневные агрегаты
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
                             or o.diesel_status = true) as selling,
       count(*) filter (where o.fuel_92_status is not null or o.fuel_95_status is not null
                             or o.diesel_status is not null) as knownany
from public.observations o
join public.stations s on s.id = o.station_id
where s.lat >= 44.60 and s.lat <= 44.85 and s.lon >= 37.55 and s.lon <= 38.05
group by 1;
alter view public.city_fuel_hourly set (security_invoker = true);

create or replace view public.city_events as
select e.station_id, e.event_type, e.detected_at
from public.events e
join public.stations s on s.id = e.station_id
where s.lat >= 44.60 and s.lat <= 44.85 and s.lon >= 37.55 and s.lon <= 38.05;
alter view public.city_events set (security_invoker = true);

create or replace view public.city_daily_events as
select date_trunc('day', e.detected_at) as day,
       count(*) filter (where e.event_type = 'fuel_disappeared') as dis,
       count(*) filter (where e.event_type = 'fuel_restored') as res
from public.events e
join public.stations s on s.id = e.station_id
where s.lat >= 44.60 and s.lat <= 44.85 and s.lon >= 37.55 and s.lon <= 38.05
group by 1;
alter view public.city_daily_events set (security_invoker = true);

-- цены города и последние цены станции
create or replace view public.city_price_hourly as
select date_trunc('hour', o.timestamp) as hour,
       percentile_cont(0.5) within group (order by o.price_92) as p92,
       percentile_cont(0.5) within group (order by o.price_95) as p95,
       percentile_cont(0.5) within group (order by o.price_diesel) as pdt,
       min(o.price_95) as min95,
       max(o.price_95) as max95,
       count(*) filter (where o.price_95 is not null) as n95,
       count(*) as marks
from public.observations o
join public.stations s on s.id = o.station_id
where s.lat >= 44.60 and s.lat <= 44.85 and s.lon >= 37.55 and s.lon <= 38.05
group by 1;
alter view public.city_price_hourly set (security_invoker = true);

create or replace view public.station_last_price as
select distinct on (station_id) station_id, price_92, price_95, price_diesel, timestamp
from public.observations
where price_92 is not null or price_95 is not null or price_diesel is not null
order by station_id, timestamp desc;
alter view public.station_last_price set (security_invoker = true);

-- эпизоды очереди домашнего бокса: gaps-and-islands
create or replace view public.city_queue_episodes as
with ev as (
  select e.station_id,
         case when e.event_type in ('queue_high','queue_appeared') then 'pos' else 'neg' end as kind,
         e.detected_at
  from public.events e
  join public.stations s on s.id = e.station_id
  where s.lat >= 44.60 and s.lat <= 44.85 and s.lon >= 37.55 and s.lon <= 38.05
    and e.event_type in ('queue_high','queue_appeared','queue_low','queue_gone')
),
numbered as (
  select station_id, kind, detected_at,
         sum(case when kind = 'pos' then 1 else 0 end)
           over (partition by station_id order by detected_at
                 rows between unbounded preceding and current row) as grp
  from ev
),
islands as (
  select station_id, grp,
         min(detected_at) filter (where kind = 'pos') as started_at,
         min(detected_at) filter (where kind = 'neg') as ended_at
  from numbered
  group by station_id, grp
)
select station_id, started_at, ended_at
from islands
where started_at is not null;
alter view public.city_queue_episodes set (security_invoker = true);

-- ==== REGION-ВЬЮХИ (city-измерение: 'south' + 9 городов) ====
-- каждая строка наблюдения/события попадает и в 'south', и в свой город
create or replace view public.region_hourly as
select g.city,
       date_trunc('hour', o.timestamp) as hour,
       count(*) as marks,
       count(*) filter (where o.queue_level = 'high') as queue_marks,
       count(*) filter (where o.fuel_95_status = true) as avail95,
       count(*) filter (where o.fuel_95_status is not null) as known95,
       count(*) filter (where o.fuel_92_status = true or o.fuel_95_status = true
                             or o.diesel_status = true) as selling
from public.observations o
join public.stations s on s.id = o.station_id
cross join lateral (
  values ('south'),
         (case
           when s.lat between 44.60 and 44.85 and s.lon between 37.55 and 38.00 then 'novorossiysk'
           when s.lat between 44.45 and 44.68 and s.lon between 37.95 and 38.25 then 'gelendzhik'
           when s.lat between 44.80 and 45.10 and s.lon between 37.20 and 37.60 then 'anapa'
           when s.lat between 44.85 and 45.05 and s.lon between 37.85 and 38.15 then 'krymsk'
           when s.lat between 44.90 and 45.15 and s.lon between 38.80 and 39.15 then 'krasnodar'
           when s.lat between 43.35 and 43.75 and s.lon between 39.60 and 40.10 then 'sochi'
           when s.lat between 44.00 and 44.20 and s.lon between 39.00 and 39.25 then 'tuapse'
           when s.lat between 44.90 and 45.10 and s.lon between 40.90 and 41.20 then 'armavir'
           when s.lat between 44.55 and 44.75 and s.lon between 40.00 and 40.30 then 'maykop'
           else null end)
) as g(city)
where g.city is not null
group by 1, 2;
alter view public.region_hourly set (security_invoker = true);

create or replace view public.region_fuel_hourly as
select g.city,
       date_trunc('hour', o.timestamp) as hour,
       count(*) filter (where o.fuel_92_status = true) as a92,
       count(*) filter (where o.fuel_92_status is not null) as k92,
       count(*) filter (where o.fuel_95_status = true) as a95,
       count(*) filter (where o.fuel_95_status is not null) as k95,
       count(*) filter (where o.diesel_status = true) as adt,
       count(*) filter (where o.diesel_status is not null) as kdt,
       count(*) filter (where o.queue_level = 'high') as q,
       count(*) as marks,
       count(*) filter (where o.fuel_92_status = true or o.fuel_95_status = true
                             or o.diesel_status = true) as selling,
       count(*) filter (where o.fuel_92_status is not null or o.fuel_95_status is not null
                             or o.diesel_status is not null) as knownany
from public.observations o
join public.stations s on s.id = o.station_id
cross join lateral (
  values ('south'),
         (case
           when s.lat between 44.60 and 44.85 and s.lon between 37.55 and 38.00 then 'novorossiysk'
           when s.lat between 44.45 and 44.68 and s.lon between 37.95 and 38.25 then 'gelendzhik'
           when s.lat between 44.80 and 45.10 and s.lon between 37.20 and 37.60 then 'anapa'
           when s.lat between 44.85 and 45.05 and s.lon between 37.85 and 38.15 then 'krymsk'
           when s.lat between 44.90 and 45.15 and s.lon between 38.80 and 39.15 then 'krasnodar'
           when s.lat between 43.35 and 43.75 and s.lon between 39.60 and 40.10 then 'sochi'
           when s.lat between 44.00 and 44.20 and s.lon between 39.00 and 39.25 then 'tuapse'
           when s.lat between 44.90 and 45.10 and s.lon between 40.90 and 41.20 then 'armavir'
           when s.lat between 44.55 and 44.75 and s.lon between 40.00 and 40.30 then 'maykop'
           else null end)
) as g(city)
where g.city is not null
group by 1, 2;
alter view public.region_fuel_hourly set (security_invoker = true);

create or replace view public.region_events as
select g.city, e.station_id, e.event_type, e.detected_at
from public.events e
join public.stations s on s.id = e.station_id
cross join lateral (
  values ('south'),
         (case
           when s.lat between 44.60 and 44.85 and s.lon between 37.55 and 38.00 then 'novorossiysk'
           when s.lat between 44.45 and 44.68 and s.lon between 37.95 and 38.25 then 'gelendzhik'
           when s.lat between 44.80 and 45.10 and s.lon between 37.20 and 37.60 then 'anapa'
           when s.lat between 44.85 and 45.05 and s.lon between 37.85 and 38.15 then 'krymsk'
           when s.lat between 44.90 and 45.15 and s.lon between 38.80 and 39.15 then 'krasnodar'
           when s.lat between 43.35 and 43.75 and s.lon between 39.60 and 40.10 then 'sochi'
           when s.lat between 44.00 and 44.20 and s.lon between 39.00 and 39.25 then 'tuapse'
           when s.lat between 44.90 and 45.10 and s.lon between 40.90 and 41.20 then 'armavir'
           when s.lat between 44.55 and 44.75 and s.lon between 40.00 and 40.30 then 'maykop'
           else null end)
) as g(city)
where g.city is not null;
alter view public.region_events set (security_invoker = true);

create or replace view public.region_daily_events as
select g.city,
       date_trunc('day', e.detected_at) as day,
       count(*) filter (where e.event_type = 'fuel_disappeared') as dis,
       count(*) filter (where e.event_type = 'fuel_restored') as res
from public.events e
join public.stations s on s.id = e.station_id
cross join lateral (
  values ('south'),
         (case
           when s.lat between 44.60 and 44.85 and s.lon between 37.55 and 38.00 then 'novorossiysk'
           when s.lat between 44.45 and 44.68 and s.lon between 37.95 and 38.25 then 'gelendzhik'
           when s.lat between 44.80 and 45.10 and s.lon between 37.20 and 37.60 then 'anapa'
           when s.lat between 44.85 and 45.05 and s.lon between 37.85 and 38.15 then 'krymsk'
           when s.lat between 44.90 and 45.15 and s.lon between 38.80 and 39.15 then 'krasnodar'
           when s.lat between 43.35 and 43.75 and s.lon between 39.60 and 40.10 then 'sochi'
           when s.lat between 44.00 and 44.20 and s.lon between 39.00 and 39.25 then 'tuapse'
           when s.lat between 44.90 and 45.10 and s.lon between 40.90 and 41.20 then 'armavir'
           when s.lat between 44.55 and 44.75 and s.lon between 40.00 and 40.30 then 'maykop'
           else null end)
) as g(city)
where g.city is not null
group by 1, 2;
alter view public.region_daily_events set (security_invoker = true);

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

-- память бота и сервиса (только service_role видит)
create table if not exists public.bot_meta (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.bot_meta enable row level security;
```

---

## Источники данных

- **GdeBenz** (основной): отметки водителей, статусы, цены, очереди. Текстовых комментариев в открытом API нет — шаг парсинга убран в collector v4, таблица `comments` спит.
  - **Домашняя рамка**: Новороссийск+Геленджик+Анапа+Крымск (~137 АЗС) — полное наблюдение каждые 10 минут.
  - **Донор-рамка волны 1**: Кубань+Адыгея (~698 АЗС, `region='kuban'`) — экономная запись (смены/heartbeat 1ч); питает бренд-пулы, эпизоды k-NN и региональные сводки.
  - **Разведка покрытия** через `probe.js` (без записи в базу): источник жив на всю Россию (80–95% станций с ценами), но толпа в абсолюте тонкая; Москва/Новосибирск — в резерве волны 3 как доноры режима NORMAL.
  - **Надёжность источника**: внешние DDoS на gdebenz.ru (09.2026) не роняют проект — коллектор переживает их мягким выходом, сайт живёт на своих данных и снимке.
- **Своя толпа**: структурированные кнопки на сайте (5 типов × топливо × размер очереди × комментарий) → `user_feedback` → события `source='user_feedback'`; на карте народные отметки работают как консенсус-фолбэк топлива (2/3 голоса, конфликт-пин) и как счётчик машин в очереди.
- Отклонено сознательно: официальные сводки (недостоверны), парсинг Яндекса/2GIS/банков (ToS и антибот), случайные Telegram-каналы (предупреждение Минэнерго).
- Кандидат для модели v2: биржевые индексы СПбМТСБ/BenzUp как макропризнак дефицита (подключать при ≥300–400 верифицированных прогнозах).

---

## Хронология проекта

| Дата | Событие |
|---|---|
| 14.09.2026 | Первая версия сайта, Supabase-подключение |
| 15.09.2026 утро | Первый рабочий коллектор, первые наблюдения |
| 15.09.2026 день | Gap-детектор, фильтр противофазы, широкая рамка, телеграм-лента, дайджест, пульс города, бренды-логотипы |
| 15.09.2026 12:11 | Первый 🟢 fuel_restored (Газпром, АИ-95) |
| 15.09.2026 21:31 | Первые прогнозы (5 Роснефтей/дизель, brand-пул) |
| 15.09.2026 вечер | Верификатор v1 + target_date, бот v2 с кнопками, security_invoker |
| 16.09.2026 день | Тепловая матрица 4×24 + кардиограмма День/Неделя/Месяц + мультивыбор отметок + дайджест 6 метрик + защищённая загрузка + честные пустые состояния |
| 17.09.2026 день | Обучающий контур v1.2; верификатор v1.2; предиктор v1.3 (k-NN); блок «Почему такой прогноз»; collector v4 без комментариев |
| 17.09.2026 поздний вечер | Предиктор v1.4; selling-нормировка очередей; «Куда ехать» с гейтом свежести; baseline + TRAINING DATA с bias; фильтр/сортировка; живая лента; режим UNKNOWN ночью |
| ночь 17→18.09.2026 | Волна 1 (донор Кубань+Адыгея): `stations.region`, экономная запись, лукбэк 24ч, вьюхи city_events/city_daily_events |
| 18.09.2026 | Карта спроса: MapLibre + OpenFreeMap positron, «чистая бумага», зоны/кластеры/пины с тап-полётом и разлётом пинов |
| ночь 18→19.09.2026 | Сайт v2.5: геолокация; зоны v2; палитра и градиентные пины; таблички с логотипом; вылетающие чипы; кольцо действий; пузырь быстрой отметки; метрики ①②③ |
| 19.09.2026 | Сайт v2.6 + предиктор v1.5: панель точности; стабильность кластеров; «Куда ехать» с расстоянием; `queue_age_min`; спокойное окно + совет «очередь HH:MM» |
| 19.09.2026 вечер | Сайт v2.7 «юг»: collector heartbeat 1ч; predictor с рамкой всего юга; 4 region-вьюхи; персональный город по геолокации; «Помощь» + приветственное окно |
| 20.09.2026 | Сайт v2.8 ч.1: кнопка «Попробовать снова»; народный консенсус на карте (2 голоса красят, 3 подтверждают, конфликт — оранжевый пин с «?», приоритет источника, голоса по device_id за 60 мин); прогноз очереди в карточке (медианное окно ±σ, своих <3 → город, why-pop) |
| 21.09.2026 | Сайт v2.8 ч.2: sheet-scroll (лечение чёрных углов мобильного Chrome); пауза пульса зон под шторкой; PWA (manifest.json, sw.js, установка на домашний экран); collector v5.1 (upstream: мягкий выход 0, троттлинг алерта ≤1ч, джиттер); predictor v1.7 (день недели в k-NN); внешний DDoS на gdebenz.ru пережит без потери данных |
| 22.09.2026 | Офлайн-контур сайта (снимок kbCache + плашка «Нет связи — данные на ЧЧ:ММ» + очередь отметок fbQueue с автоотправкой); гуманизация ошибок загрузки; calibrator v1→v3 + calibrate.yml + cron 02:25 MSK (починка ошибки выжившего, свежесть 14/30 дней, ворота 30/10/15 п.п., PAVA, самоудаление таблицы); predictor v1.8 (применение калибровки, `conf_raw`, `model_version v1.2`); sw.js: кэш только ok-ответов, CACHE_VERSION v3 |