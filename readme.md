# ⛽ КогдаБенз — «когда лучше заправиться?»

Система временнóго прогнозирования для водителей Новороссийска.
Мы не копируем чужие карты наличия топлива — мы отвечаем на вопрос «КОГДА»:
когда на конкретной АЗС вероятно вернётся топливо и когда лучше заехать.
Цель: собрать историю изменений АЗС → найти закономерности → предсказать окно
пополнения → проверять прогнозы на фактах → улучшать точность.

## Как работает система

```
GdeBenz API (домашняя рамка: Новороссийск+Геленджик+Анапа+Крымск, ~137 АЗС)
       + донор-рамка "Кубань+Адыгея" (~698 АЗС, region='kuban')
         ↑ каждые 10 минут будит cron-job.org → workflow_dispatch
collector.js (GitHub Actions, чистый fetch, v5):
   дом: станции → наблюдения → события (топливо/очереди, gap-детектор, фильтр противофазы)
   донор: станции → экономная запись (смена статуса / heartbeat 6ч / первая встреча)
   → народные отметки user_feedback → события → уборка наблюдений >30 дней
   → Telegram-лента «живая хроника» (с учётом тихого режима bot_meta.notify)
         ↓
Supabase: stations / observations / events / predictions /
          user_feedback / bot_meta + вьюхи (security_invoker)
         ↓
predictor.js v1.5:
   медиана±σ по Москве, пулинг own→brand→city, модель длительности дефицита,
   k-NN по эпизодам "исчезло→вернулось" (порог ≥8, иначе медиана-фолбэк),
   features-снапшот (час/день, возраст дефицита, очередь+тренд+queue_age_min,
   город, соседи без 95, возвраты/исчезновения, режим, k-NN),
   режим города (NORMAL/LOCAL/CITY/RECOVERY/UNKNOWN), гейт молчащих станций,
   baseline_restore_at для сравнения, прицел target_date "сегодня"/"завтра"
         ↓
verifier.js v1.2 (02:10 MSK, ежедневно):
   оценивает вчерашние прогнозы по фактам → SUCCESS/MISS → is_verified
   + величина ошибки: actual_restore_at, error_minutes, baseline_error_minutes
   + TRAINING DATA в логе (MAE/медиана/p90 + bias + разбивки по режиму/источнику/k-NN/часу)
         ↓
prediction_training (вьюха): верифицированные прогнозы с features и ошибкой
         ↓ (по мере накопления ≥100 строк)
калибровка confidence по децилям · тюнинг k-NN · shadow-сравнение версий
         ↓
digest.js (08:00 MSK, ежедневно): сводка за 24 ч в Telegram
bot.js (каждые 5 мин): читает обновления Telegram, отвечает на кнопки /status /predict /digest /quiet /loud
         ↓
Сайт (GitHub Pages): карточки + карта спроса (геолокация и точка «я здесь»,
   кластеры/пины/зоны с пульсом, палитра пинов по топливу и градиентные пины,
   бейдж очереди, таблички названий, вылетающие чипы, кольцо действий,
   быстрая отметка с подтверждением) + тепловая матрица + пульс города
   + метрики (покрытие источника, возраст очереди, цены города в карточке)
   + панель «Наша точность прогнозов» + «Почему такой прогноз»
   + «Куда ехать» с гейтом свежести и расстоянием + фильтр/сортировка
   + честный ночной заголовок
```

## Состав репозитория

| Файл | Роль | Статус |
| --- | --- | --- |
| collector.js | Сборщик v5: дом + доноры, экономная запись доноров (heartbeat 6ч + смены), лукбэк 24ч, живая лента, gap-детектор, фильтр противофазы, народные отметки, уборка | ✅ прод |
| predictor.js | Предиктор v1.5: пулинг own/brand/city, модель дефицита + k-NN, снапшот features (включая queue_age_min), режим города (включая UNKNOWN ночью), гейт молчащих станций, baseline_restore_at | ✅ прод |
| verifier.js | Верификатор v1.2: величина ошибки + TRAINING DATA с bias и разбивками; logTrainingData вынесена в функцию и вызывается на обоих путях | ✅ прод |
| probe.js | Разведка покрытия GdeBenz по рамкам (без записи в базу): станции / с топливом / с ценами / с очередями | ✅ прод |
| digest.js | Утренний дайджест за 24 ч | ✅ прод |
| bot.js | Бот с кнопками: отчёты и тихий режим (серверлесс, без сервера) | ✅ прод |
| index.html | Сайт v2.6: карточки + карта спроса (геолокация, кластеры/пины/зоны, кольцо действий, быстрая отметка, таблички и вылетающие чипы) + тепловая матрица + пульс + метрики (покрытие, возраст очереди, цены в карточке) + панель «Наша точность прогнозов» + «Почему такой прогноз» + «Куда ехать» с гейтом свежести и расстоянием + фильтр/сортировка + честный ночной заголовок | ✅ прод |
| .github/workflows/collect.yml | dispatch + «Telegram on failure» | ✅ прод |
| .github/workflows/digest.yml | dispatch дайджеста | ✅ прод |
| .github/workflows/verify.yml | dispatch верификатора | ✅ прод |
| .github/workflows/bot.yml | dispatch бота (каждые 5 мин) | ✅ прод |
| .github/workflows/probe.yml | dispatch разведки покрытия (по требованию) | ✅ прод |
| README.md | Этот документ | ✅ |
| statistics.js, confidence.js, handler.js, comments.js, events.js, gdebenz.js, scheduler.js, setup.js | Черновики-спецификации этапов E/F (confidence.js — легаси-дубль верификатора, не используется) | 📐 затем в legacy/ |

Внешние сервисы:
- cron-job.org — основной будильник: каждые 10 минут — `collect`, каждые 5 минут — `bot`, ежедневно 08:00 MSK — `digest`, ежедневно 02:10 MSK — `verify`. Все через GitHub API `workflow_dispatch`. PAT fine-grained: Actions Read and write, только этот репозиторий.
- Telegram-бот «КогдаБенз Алерт» — живая хроника событий с человеческой формулировкой и выводом для водителя, 🔮 первые прогнозы, 🚨 аварии, 🌅 дайджест, кнопки-отчёты, тихий режим.
- Родной GitHub `schedule` на этом репозитории не срабатывал ни разу — внешний будильник считается основным.

## База данных (Supabase)

| Таблица | Что хранит |
| --- | --- |
| stations | Реестр АЗС (external_id = osm_id, brand, address, lat/lon, source, region, fuels_meta) |
| observations | Снимки статусов каждые 10 мин (+ data_freshness_minutes, queue_level, цены price_92/95/diesel); для доноров — экономно (смены/heartbeat 6ч) |
| events | Изменения: топливные, очередные, народные |
| predictions | Окна прогнозов + prediction_source + based_on_stations + expected_restore_at + baseline_restore_at + target_date + result/is_verified + features (jsonb-снапшот признаков) + model_version + actual_restore_at + error_minutes + baseline_error_minutes |
| user_feedback | Структурированные народные отметки: feedback_type + fuel_type + queue_size + comment_text |
| bot_meta | Состояние бота (update_offset, notify режим) — только service_role |
| comments | Текстовые комментарии (источник не даёт — таблица спит; шаг парсинга убран в collector v4) |

Вьюхи (обход лимита Supabase REST в 1000 строк + безопасный RLS-режим):
- `station_counts` — настоящее общее число наблюдений по станции
- `station_hourly` — почасовая доступность АИ-95 для графиков карточек
- `city_hourly` — пульс города: очереди и АИ-95 по часам (кардиограмма «День»); колонка `selling` — станции с любым топливом (знаменатель честных очередей)
- `city_fuel_hourly` — 4 ряда тепла по часам (АИ-92/95/ДТ/Очереди) + `selling` для тепловой матрицы + `knownany` (станции с любым ненулевым статусом топлива — покрытие источника)
- `city_events` — события строго по bbox Новороссийска (кардиограмма «День», дайджест, чипы города); доноры и широкая рамка не попадают
- `city_daily_events` — дневные агрегаты исчезновений/возвратов, также bbox-фильтрация
- `city_price_hourly` — почасовые медианы цен города по трём топливам + min/max АИ-95 + покрытие ценами (дельты цен в карточке)
- `station_last_price` — последние известные цены станции (цены в карточке с дельтой к городу)
- `city_queue_episodes` — эпизоды очереди по городу gaps-and-islands (начало/конец, ended_at null = стоит сейчас): возраст очереди на пине и в карточке, медиана очереди в дайджесте
- `prediction_training` — учебная выборка: верифицированные прогнозы с `error_minutes` и `features` (вход калибровки и тюнинга k-NN)

Все вьюхи установлены с `security_invoker = true` — RLS-политики применяются под маской запросившего, а не создателя вьюхи.

Белые списки (check-constraints):
- `events_event_type_check`: fuel_disappeared, fuel_restored, fuel_available, fuel_unavailable, possible_delivery, queue_high, queue_low, queue_appeared, queue_gone
- `user_feedback_insert` (RLS policy): feedback_type/fuel_type/queue_size только из списка чипсов, device_id обязателен

Правило: новый тип события = сначала расширить constraint, потом писать код.

## Что сделано (статус на 19.09.2026)

- [x] Этап 1: исследован реальный API GdeBenz (формат, защита от ботов, отсутствие текстовых комментариев)
- [x] Этап 2: коллектор на GitHub Actions; «паспорт браузера» + 3 повтора против 502
- [x] Этап 3: история наблюдений; широкая рамка 4 городов (~137 АЗС за запуск)
- [x] Этап 4: детектор событий; gap-детектор (окно 36 ч сквозь ночные null) + фильтр противофазы
- [x] Безопасность: service_role только в секретах; RLS везде; вьюхи security_invoker; белый список user_feedback; аноним = select
- [x] Этап 5: предиктор v1 → v1.1 (пулинг own→brand→city, модель длительности дефицита, expected_restore_at, всё по Москве)
- [x] Первый 🟢 fuel_restored (15.09, 12:11 — Газпром · Кольцевая, 19, АИ-95)
- [x] Первые прогнозы (15.09, 21:31 — пять Роснефтей/дизель, source=brand, 5 станций)
- [x] Этап 6/D: верификатор v1 с прицелом `target_date`, первые вердикты 0/5 как калибровочная точка
- [x] Этап 8/9: сайт v2 (факт/прогноз/точность раздельно, ≈% по свежести, почасовой чарт, избранное, гео-сортировка, народные кнопки с топливом и размером очереди)
- [x] Пульс города: светлый премиум SVG (области спроса/предложения, колонны света событий, KPI-чипы, метка «СЕЙЧАС», табы 24 ч / 7 дн / 30 дн)
- [x] Бот v2: кнопки-отчёты, тихий/громкий режим, serverless на cron-job.org
- [x] Бренды логотипами: BRAND_LOGOS, детектор кириллицы+латиницы, onerror-фолбэк
- [x] Дайджест 08:00 MSK + точность прогнозов в дайджесте (при ≥10 проверок)
- [x] Гигиена базы: автоудаление наблюдений старше 30 дней
- [x] Советник безопасности Supabase: вьюхи security_invoker, белый список user_feedback
- [x] Тепловая матрица города (16.09): 4 ряда × 24 часа, линия «сейчас», легенда 4 уровня, статусы «есть/мало/нет»
- [x] Кардиограмма с тремя режимами (16.09): День / Неделя / Месяц с колоннами событий из `city_daily_events`
- [x] Мультивыбор отметок (16.09): чек-лист «есть/нет 92/95/ДТ + очередь + привезли + свободно» → одна отправка создаёт до N строк user_feedback
- [x] Дайджест-панель (16.09): 6 метрик + полоса средней доступности АИ-95 + избранное
- [x] Защищённая загрузка данных (16.09): каждый запрос в своём try/catch; контрольная перерисовка через 400 мс
- [x] Честные пустые состояния (16.09): серые плашки вместо невидимых ячеек
- [x] Чипы «Сейчас · АИ-95 есть» (16.09): формулировка «N из M АЗС», плюс «Пик спроса» и «Спокойно»
- [x] Починка кардиограммы Неделя/Месяц (17.09); шапка сайта v2 (17.09)
- [x] Обучающий контур v1.2 (17.09): миграция (actual_restore_at, error_minutes, features jsonb, model_version, индекс, вьюха prediction_training); снапшот признаков в момент прогноза
- [x] Верификатор v1.2 (17.09): величина ошибки вместо голого SUCCESS/MISS; знак ошибки = направление
- [x] Предиктор v1.3 / k-NN (17.09): база эпизодов «исчезло→вернулось» с контекстом; похожие ситуации для ETA при поддержке ≥8, иначе медиана-фолбэк
- [x] Блок «Почему такой прогноз» (17.09): чипы-причины из `features` в карточке АЗС
- [x] Collector v4 (17.09): шаг парсинга комментариев удалён; прогон 58 с → ~10 с
- [x] Предиктор v1.4 / гейт молчащих станций (ночь 17→18.09): данные источника старше 7 суток снимают станцию с прогнозов
- [x] Честные очереди в дефицит (ночь 17→18.09): колонка `selling` в city-вьюхах; очереди нормируются на торгующие станции
- [x] «Куда ехать» с гейтом свежести (ночь 17→18.09): совет только при данных ≤6 ч; приоритет «АИ-95 есть → любое топливо → открытое окно → окно в ближайшие 3 ч»
- [x] Baseline-сравнение (ночь 17→18.09): baseline_restore_at/baseline_error_minutes + TRAINING DATA (MAE/медиана/p90 по обеим)
- [x] Разведка покрытия GdeBenz (ночь 17→18.09): probe.js; выбрана рамка-донор «Кубань+Адыгея» (~698 станций)
- [x] Волна 1: донор Кубань+Адыгея (ночь 17→18.09): stations.region; экономная запись; лукбэк 24ч; доноры кормят бренд-пулы и эпизоды k-NN
- [x] Кардиограмма «День» и дайджест строго по городу (ночь 17→18.09): вьюхи city_events / city_daily_events с bbox
- [x] Живая лента уведомлений (ночь 17→18.09): eventStoryRu + STORY_VARIANTS; шапка хроники; городская строка; подсказки 💡; нарратив верификатора
- [x] Фильтр/сортировка на сайте (ночь 17→18.09): «Только с прогнозом», «Сортировка: ближайшее окно»
- [x] Честный ночной заголовок панели (ночь 17→18.09): при known95 = 0 — «Ждём свежие данные»
- [x] Режим UNKNOWN ночью (ночь 17→18.09): ночные строки обучения не несут ложный NORMAL
- [x] Ось тепловой матрицы 24:00 → 00:00 (ночь 17→18.09)
- [x] logTrainingData как функция (ночь 17→18.09): пустой прогон честно печатает TRAINING DATA и счётчик цензурированных
- [x] Карта спроса (18.09): MapLibre + OpenFreeMap positron; «чистая бумага»; зоны спроса; кластеры (квадраты с цифрой и полосой состава, сетка ~70px на мировых координатах); пины (капля + оранжевая точка очереди); тап-полёт; разлёт пинов из центров кластеров; подписи городов и районов
- [x] Геолокация на сайте (ночь 18→19.09): карта стартует с сохранённой позиции (localStorage, 7 суток), автоопределение при входе, кнопка «Рядом» с полётом, синяя пульсирующая точка «я здесь»
- [x] Зоны спроса v2 (ночь 18→19.09): видны с zoom 12 как «дышащее» кольцо (прозрачность и толщина — обычные числа из JS по зуму: составные выражения с interpolate(zoom) MapLibre применяет непредсказуемо); иконка очереди в центре кольца вдали, при приближении плавно уменьшается и уезжает в левый нижний угол пина
- [x] Палитра пинов по топливу (ночь 18→19.09): зелёный = АИ-95 есть, оранжевый = есть 92, светло-синий = только дизель, красный = ничего, серый = нет данных; два-три топлива — градиент от кончика вверх (дизель → 92 → 95) с белой окантовкой; приоритет наложения по ценности; полоса кластера теми же пятью цветами
- [x] Таблички над пинами (ночь 18→19.09): логотип бренда + название жирным + улица обычным; в покое притушены (45%), оживают под меню/пузырём
- [x] Вылетающие чипы над названием (ночь 18→19.09): топливо в цветах палитры (95 зелёный, 92 оранжевый, дизель синий) с вылетом из таблички; очередь уровнями «огромная/терпимая/малая» с возрастом и народным счётчиком машин; народные топливные отметки как фолбэк при молчании источника («· народ»); серый чип «топливо: источник молчит»
- [x] Кольцо действий в стиле The Sims (ночь 18→19.09): тап по капле вместо popup открывает три синих чипа (В избранное / Отметка / Карточка АЗС); чипы владеют жестом сами, действие на click
- [x] Быстрая отметка (ночь 18→19.09): пузырь по центру карты с чипами карточки (топливо есть/нет, очередь, привезли/свободно), отправка в user_feedback с антиспамом ≤3/30 мин и подтверждением «Спасибо за вашу отметку 🙏» + автозакрытие 1.2 с; карточка АЗС не открывается
- [x] «Показать на карте» в карточке (ночь 18→19.09): закрытие карточки, полёт к пину zoom 15; карточка, открытая с карты, при закрытии возвращает на панель карты (центр и зум не тронуты)
- [x] Метрика ① цены города (ночь 18→19.09): вьюхи city_price_hourly + station_last_price; ряд цен в карточке над прогнозом с дельтой к городской медиане (полоса на главной убрана решением продукта как недодающая ценности)
- [x] Метрика ② покрытие источника (ночь 18→19.09): колонка knownany в city_fuel_hourly; чип плашки «топливо видно: N из M АЗС» со спарклайном за 24 ч; тап по чипу — список видимых источником станций с точками по топливам и полётом к выбранной
- [x] Метрика ③ возраст очереди (ночь 18→19.09): вьюха city_queue_episodes (gaps-and-islands по очередным событиям источника и народа); «очередь стоит X» в вылетающем чипе и полосой в карточке; медиана завершённых очередей за сутки в дайджест-полосе
- [x] Признак queue_age_min в предикторе (ночь 18→19.09, v1.5): минуты с момента появления очереди в снапшоте features — задел под Model v2
- [x] Шапка панели списка (ночь 18→19.09): «АЗС города» с подзаголовком как у остальных панелей; «Показано N» вместо дубля заголовка
- [x] Легенда карты в две строки с заголовками (ночь 18→19.09): «зоны на карте — сила очередей» (спокойно / малая / терпимая / огромная) и «цвет пина — топливо по отметкам»; каждая строка в одну линию со скроллом на узких экранах
- [x] Панель «Наша точность прогнозов» (19.09): слева от главной, при открытии сайт стоит на главной; честное нулевое состояние «Пока нечего измерять: 0 из N прогнозов получили факт возврата топлива» с объяснением цензурирования; эволюция 3+ измеренных → chips + график «модель vs baseline» + гистограмма |ошибки| + истории «прогноз → факт», 10+ проверенных → процент попадания в окно, 100+ → калибровка
- [x] Стабильность кластеров при панорамировании (19.09): ячейки считаются по всем станциям, рисуются только кластеры с центром в кадре — состав и центр не зависят от пана
- [x] «Куда ехать» с расстоянием (19.09): штраф min(25, км × 1.5) от геолокации пользователя в счётчике ценности; кнопка показывает «· 1.2 км»; ближняя станция с топливом бьёт дальнюю
- [x] Гуманизация текстов (19.09): подзаголовок карты «Каждая капля — заправка: цвет говорит, какое топливо есть сейчас, а круг вокруг — где очередь. Нажми на каплю — появятся кнопки»; теглайн дайджеста без упоминания Telegram; строка «Полный дайджест приходит в Telegram…» убрана из панели
- [ ] Волна 2: Ростов/Ставрополь (~1575 станций) — после замера выхода эпизодов с Кубани за неделю
- [ ] Волна 3: Москва/Новосибирск — доноры режима NORMAL под калибровку
- [ ] Калибровка confidence по децилям (старт при ≥100 строк в `prediction_training`)
- [ ] Shadow-сравнение версий модели по `model_version` (прод = лучшая по медиане |error|)
- [ ] Мультирегион на сайте: переключатель городов после накопления донорами истории и верифицированных прогнозов
- [ ] Очереди этап 2: народные события queue_high/queue_appeared в почасовом q; модельная оценка очереди в дефицит с явной подписью «оценка»
- [ ] Метрика ④ сходимость народных отметок с источником и метрика ⑤ цензурирование в дайджесте — заморожены решением продукта (кандидаты в панель точности, не на главную и не в дайджест)
- [ ] Этап 7/F: модель v2 (день недели, триггер очереди с лагом, загруженность, биржевой фон)
- [ ] «Тихие часы» per-АЗС (закрыть обещание hero: «и меньше очередей»)
- [ ] Кнопка «поделиться прогнозом» (Web Share API)
- [ ] Черновики → `legacy/`; резервная копия базы раз в неделю
- [ ] Публичный Telegram-канал с утренним дайджестом для города

## Правила проекта (обязательны для любого нового кода)

- Запросы к GdeBenz — только с `BROWSER_HEADERS` и повторами.
- Рабочий код не переписываем с нуля: возможности дописываются шагами.
- Новые скрипты — один файл, чистый fetch, без npm-зависимостей.
- Всё время — явно по Москве (UTC+3): Actions и база живут в UTC.
- Факт и прогноз в интерфейсе разделены всегда (ТЗ §15).
- Точность показываем только при ≥10 проверенных прогнозах (ТЗ §12).
- Прогноз прицеливается на дату (`target_date`): если окно уже в прошлом сегодня — прогноз на завтра. Верификатор трогает только вчерашние цели.
- Официальные городские сводки не используем; Яндекс/2GIS/банки не парсим (ToS, антибот) — данные берём легально: GdeBenz API + своя толпа.
- Очередь — опережающий сигнал: появилась раньше отметок топлива.
- Фильтр противофазы: дизель и бензин в противофазу за один снимок = артефакт состава отметок, дизельный флаг выбрасываем.
- Новый тип события → сначала белый список constraint, потом код.
- Помним про лимит Supabase REST (1000 строк): агрегаты считаем вьюхами, а не выгрузкой сырых строк.
- Вьюхи — всегда `security_invoker = true`, чтобы RLS работал сквозь них.
- Народные отметки с структурой → в базе только значения из белого списка (RLS policy).
- Серверлесс где возможно: бот без сервера, на cron-job.org + Supabase meta-таблица.
- Отказоустойчивость сайта: каждый внешний запрос к вьюхе в своём try/catch; отрисовка блоков не падает от одной упавшей вьюхи.
- Пустые состояния видимы: нет данных → серая плашка с объяснением, не «пусто на белом» и не суррогат ради плотности.
- Мультивыбор в UI: несколько фактов одновременно — отправляем массивом.
- Обучение только на верифицированных исходах: верификатор — единственные ворота обучения.
- `CREATE OR REPLACE VIEW`: новые колонки только дописываются в конец — иначе ошибка 42P16.
- Изменения модели — аддитивно с фолбэком на малых данных: k-NN при поддержке ≥8 эпизодов, иначе старая медиана.
- Измерение раньше усложнения: сначала error_minutes/baseline_error_minutes и TRAINING DATA, потом новые модели; тяжёлое ML — не раньше сотен верифицированных прогнозов.
- Экономная запись донор-наблюдений: для станций с `region` не null — только смены/heartbeat 6ч/первая встреча.
- Городские сводки — только из city-вьюх с bbox Новороссийска.
- Карта спроса: чужие слои скрываем рантаймом после `load`; кластеры считаем на мировых координатах по всем станциям (состав и центр не зависят от пана), рисуем только центры в кадре; тап по маркерам слушаем в capture-фазе document.
- Панели сайта не скроллятся вниз (кроме списка «АЗС города»): новые сущности — только оверлеи (плашка карты, кольцо действий, пузырь отметки, раскрытия чипов) или уплотнение существующих блоков.
- Быстрые действия на карте работают без открытия карточки; любая отправка народной отметки обязана иметь видимое подтверждение.
- Палитра едина: один цвет одного смысла во всех сущностях карты (пины, полоса кластера, вылетающие чипы, легенда).
- Прозрачности и толщины GL-слоёв задаём обычными числами из JS (рампа по зуму + пульс): составные выражения с `interpolate(zoom)` MapLibre применяет непредсказуемо.
- Анимации маркеров не перебивают центрирующий transform: отдельные keyframes с translate внутри.
- Советник «Куда ехать» учитывает расстояние: штраф min(25, км × 1.5) от геолокации пользователя, кнопка показывает километры; гейт свежести ≤6 ч сохраняется.

## Запуск и проверка

- Ручной прогон: Actions → любой workflow → Run workflow.
- Норма collect: `Станций в ответе: ~137` + `Донор kuban: станций ~698` + `Наблюдений записано: ~835 (дом 137 + доноры 698)`; в последующих `доноры` = единицы-десятки; + блок предиктора: `Контекст города: … режим …`, `Эпизодов дефицита для k-NN: N`, `Создано: N, обновлено: N, пропущено: N, молчащих станций (>72ч): N`.
- Норма probe: `=== РАЗВЕДКА ПОКРЫТИЯ GdeBenz ===` + по строке на каждую рамку.
- Норма digest: одно сообщение в Telegram вида «🌅 КогдаБенз · дайджест за сутки…».
- Норма bot: `/start` → клавиатура кнопок → «📊 Сводка города» → отчёт о дефицитах и очередях.
- Норма verify: ночью в логе построчные ✅ SUCCESS / ❌ MISS с величиной ошибки (`· ошибка +N мин`) и TRAINING DATA (пустой прогон тоже печатает: `верифицированных с ошибкой пока нет (цензурировано без факта: N)`).
- Норма сайта: тепловая матрица 4×24 раскрашена; кардиограмма переключается День/Неделя/Месяц; мультивыбор создаёт несколько строк user_feedback; блок «Почему такой прогноз» показывает чипы причин; фильтр/сортировка работают; карта стартует с геолокации, тап по капле открывает кольцо действий, «Отметка» даёт пузырь с чипами и подтверждением «Спасибо 🙏»; плашка показывает чип покрытия со спарклайном и раскрываемым списком; панель точности слева от главной показывает честное нулевое состояние с счётчиком 0/N и оживает при 3+ измеренных; «Куда ехать» показывает километры и ведёт на ближнюю станцию с топливом.
- SQL-самопроверка:

```sql
select event_type, count(*) from events group by event_type;
select count(*) filter (where timestamp > now() - interval '1 hour') as за_час,
       count(*) as всего from observations;
select region, count(*) from stations group by 1;
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
select count(*) from city_price_hourly where hour > now() - interval '7 days';
select count(*) from city_queue_episodes where started_at > now() - interval '3 days';
```

- Table Editor показывает время в UTC; новороссийское = +3.

## Безопасность

- Секреты GitHub: `SUPABASE_URL`, `SUPABASE_KEY` (service_role), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- В клиентский код (`index.html`) — только anon-ключ.
- PAT для cron-job.org: fine-grained, Actions Read and write, один репозиторий; ротация при любой утечке.
- Антиспам народных отметок: ≤3 с устройства за 30 минут (localStorage) + RLS-белый список типов/топлива/размеров очереди.
- Вьюхи `security_invoker` = RLS применяется под маской запросившего.
- `bot_meta` доступна только service_role — состояние бота не торчит наружу.
- `probe.js` не требует секретов: только публичный GdeBenz с паспортом браузера.

## Troubleshooting

| Симптом | Причина / лечение |
| --- | --- |
| GdeBenz ответил 502/403 | Защита от ботов или чих: BROWSER_HEADERS + 3 повтора уже в коде; план Б — cookie в секреты |
| violates check constraint events_event_type_check | Новый тип события не в белом списке → расширить constraint |
| Dispatch от cron-job: 404 Not Found | Workflow-файл лежит не в `.github/workflows/` (классика мобильного GitHub: папка-двойник) |
| ReferenceError: X is not defined после заплатки | Объявление переменной внутри блока `if` — вынести на уровень использования |
| SyntaxError: Unexpected end of input после серии заплаток | Разбаланс фигурных скобок при ручной вставке кусков — заменить файл целиком на выверенный |
| Сайт показывает мало наблюдений/пустой чарт | Упёрлись в лимит 1000 строк REST — брать агрегаты из вьюх station_counts / station_hourly |
| NaN дн назад в карточке | Перепутан порядок распаковки Promise.all с порядком запросов; сверить имена |
| Родной cron молчит | Известная особенность этого репозитория — основной будильник cron-job.org |
| Красный запуск | Прилетит 🚨 в Telegram; смотреть шаг Run collector |
| Карусель 🔮/: прогноз создаётся и тут же MISS | Не установлен target_date — прогноз целился на уже прошедшее окно |
| Дизельные «🟢 вернулся» в парах с бензинными 🔴 | Артефакт состава отметок: фильтр противофазы в collector.js должен вырезать дизельный флажок |
| Security Definer View в советнике Supabase | Вьюхи должны быть `security_invoker = true` |
| RLS Policy Always True на user_feedback | Заменить на белый список типов/топлива/очередей |
| Бот молчит больше 5 минут | Проверить: cron-job.org → bot-джоба → Actions; `bot_meta.update_offset` должен расти |
| Тепловая матрица серая / кардиограмма пустая | Вьюха city_fuel_hourly или city_daily_events не создана — выполнить SQL из приложения |
| Дайджест показывает нули при живом теглайне | renderNow() не дёргается после loadPulse() — должен быть в setTimeout(400ms) |
| Кардиограмма Неделя/Месяц: b.getFullYear is not a function | sameDay(nowD, b) получил объект-бакет вместо даты: правильно sameDay(nowD, b.t) |
| 42P16 cannot change name of view column при пересоздании вьюхи | В CREATE OR REPLACE VIEW новые колонки дописываются только в конец (selling / baseline_error_minutes / knownany) |
| Строка «Очереди» серая, линия спроса нулевая после патча | Новая колонка вьюхи (selling) не добавлена в явный select= запроса сайта — дописать |
| Очереди «всё зелёное» при живых пробках | Знаменатель «все станции» размывает очередь дефицита; очереди нормируются на selling |
| «Куда ехать» ведёт на дальнюю АЗС | Советник не смотрел расстояние: добавлен штраф min(25, км × 1.5) и километры на кнопке |
| «Куда ехать» ведёт на АЗС с «нет данных» | Гейт data_freshness_minutes ≤ 360 и приоритет «топливо есть сейчас» |
| «Молчащих станций: 28 из 29» после гейта | Гейт только по data_freshness_minutes > 7 сут (возраст строки непригоден в дефицит) |
| prediction_training = 0 сразу после миграции | Норма до первого verify новым кодом (02:10 MSK): старый верификатор error_minutes не писал |
| Цензурировано: 100% верифицированных / панель точности 0/N | В дни глубокого дефицита возвраты редки и случаются не по тем парам (станция+топливо), по которым созданы проверенные прогнозы; MISS без факта = error_minutes null; это сигнал, не поломка; панель оживёт при 3+ измеренных |
| Мультивыбор отправляет только один факт | fbSend должен собирать массив rows из .selected, а не брать fbDraft |
| «Доноры 0» во 2+ прогоне collect | Норма после первого прогона: доноры записываются только при смене статуса/очереди или heartbeat раз в 6 ч |
| regime:UNKNOWN в TRAINING DATA | Норма для ночных часов с known95 = 0 |
| TRAINING DATA не печатается в пустом прогоне verify | Оставить только вызов await logTrainingData() в двух местах |
| Кардиограмма «День» / дайджест показывают события из Геленджика | Вьюха city_events не создана или не подключена в loadPulse |
| Карта не загружается / белое пятно | Тайлы OpenFreeMap — внешний хост, из РФ может идти медленно; заменить URL стиля одной строкой в ensureMap |
| Тап по квадрату кластера не летит | Нужен document-детектор в capture-фазе с preventDefault() на pointerdown по маркеру и задержкой полёта ~120 мс после pointerup |
| Пины плавают во время жестов панорамирования | CSS .maplibregl-marker с transition:none !important; animation:none !important; will-change:transform — не перебивать |
| Кластеры прыгают при панорамировании и меняют цифру | Ячейки считались только по видимым станциям: состав и центр менялись от пана; считать по всем станциям, рисовать только центры в кадре |
| Зоны спроса пропали после патча прозрачности | Составное выражение ['*', interpolate(zoom), число] для fill/line-opacity MapLibre не применяет — прозрачность и толщина только обычными числами (zoneRamp + startZonePulse) |
| Чипы кольца «съезжали» при появлении | Анимация mPopBox перебивала центрирующий translate(-50%,-50%); у кольца свои keyframes mPopRing с translate внутри |
| Синие чипы кольца не реагировали на тап | Чипы лежат внутри обёртки пина, где висит preventDefault pointerdown; чип владеет жестом сам (stopPropagation pointerdown/pointerup), действие на click |
| Плашка/полоса рвёт слова при переносе | Неразрывные сегменты .ps-wrap / .ps: перенос только между смысловыми блоками |
| Быстрая отметка отправлялась «в тишину» | Подтверждение обязательно: пузырь показывает «Спасибо за вашу отметку 🙏» и сам закрывается через 1.2 с |
| Чип покрытия всегда «0 из N» | knownany не добавлен в явный select= запроса сайта к city_fuel_hourly — дописать |
| Многоточие в ячейках карточки | text-overflow: ellipsis режет длинный хвост; цена и дельта разнесены на две строки (.info-value + .info-delta) |

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

-- тепловая матрица: 4 ряда × 24 часа + selling + knownany (покрытие источника).
-- ВНИМАНИЕ: knownany дописана в конец (правило 42P16)
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

-- события строго по bbox Новороссийска (кардиограмма "День", дайджест, чипы)
create or replace view public.city_events as
select e.station_id, e.event_type, e.detected_at
from public.events e
join public.stations s on s.id = e.station_id
where s.lat >= 44.60 and s.lat <= 44.85 and s.lon >= 37.55 and s.lon <= 38.05;
alter view public.city_events set (security_invoker = true);

-- дневные агрегаты событий (для кардиограмм "Неделя"/"Месяц") — только город
create or replace view public.city_daily_events as
select date_trunc('day', e.detected_at) as day,
       count(*) filter (where e.event_type = 'fuel_disappeared') as dis,
       count(*) filter (where e.event_type = 'fuel_restored') as res
from public.events e
join public.stations s on s.id = e.station_id
where s.lat >= 44.60 and s.lat <= 44.85 and s.lon >= 37.55 and s.lon <= 38.05
group by 1;
alter view public.city_daily_events set (security_invoker = true);

-- цены города: почасовые медианы по трём топливам, разброс и покрытие ценами
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

-- последние известные цены станции (строки, где хоть одна цена не null)
create or replace view public.station_last_price as
select distinct on (station_id) station_id, price_92, price_95, price_diesel, timestamp
from public.observations
where price_92 is not null or price_95 is not null or price_diesel is not null
order by station_id, timestamp desc;
alter view public.station_last_price set (security_invoker = true);

-- эпизоды очереди по городу: начало (pos) и конец (neg, null = стоит сейчас).
-- gaps-and-islands: подряд несколько pos склеиваются в один эпизод
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

## Источники данных

- GdeBenz (основной): отметки водителей, статусы, цены, очереди. Текстовых комментариев в открытом API нет — шаг парсинга убран в collector v4, таблица `comments` спит.
- Домашняя рамка: Новороссийск+Геленджик+Анапа+Крымск (~137 АЗС) — полное наблюдение каждые 10 минут.
- Донор-рамка волны 1: Кубань+Адыгея (~698 АЗС, `region='kuban'`) — экономная запись (смены/heartbeat 6ч); питает бренд-пулы и эпизоды k-NN.
- Разведка покрытия через `probe.js` (без записи в базу): источник жив на всю Россию (80–95% станций с ценами), но толпа в абсолюте тонкая; Москва/Новосибирск — в резерве волны 3 как доноры режима NORMAL.
- Своя толпа: структурированные кнопки на сайте (5 типов × топливо × размер очереди × комментарий) → `user_feedback` → события `source='user_feedback'`; на карте народные отметки работают как фолбэк топлива («· народ») и как счётчик машин в очереди.
- Отклонено сознательно: официальные сводки (недостоверны), парсинг Яндекса/2GIS/банков (ToS и антибот), случайные Telegram-каналы (предупреждение Минэнерго).
- Кандидат для модели v2: биржевые индексы СПбМТСБ/BenzUp как макропризнак дефицита (подключать при ≥300–400 верифицированных прогнозах).

## Хронология проекта

| Дата | Событие |
| --- | --- |
| 14.09.2026 | Первая версия сайта, Supabase-подключение |
| 15.09.2026 утро | Первый рабочий коллектор, первые наблюдения |
| 15.09.2026 день | Gap-детектор, фильтр противофазы, широкая рамка, телеграм-лента, дайджест, пульс города, бренды-логотипы |
| 15.09.2026 12:11 | Первый 🟢 fuel_restored (Газпром, АИ-95) |
| 15.09.2026 21:31 | Первые прогнозы (5 Роснефтей/дизель, brand-пул) |
| 15.09.2026 вечер | Верификатор v1 + target_date, бот v2 с кнопками, security_invoker |
| 16.09.2026 день | Тепловая матрица 4×24 + кардиограмма День/Неделя/Месяц + мультивыбор отметок + дайджест 6 метрик + защищённая загрузка (try/catch per view) + честные пустые состояния |
| 17.09.2026 день | Починка кардиограммы Неделя/Месяц; шапка v2; обучающий контур v1.2 (features, error_minutes, prediction_training); верификатор v1.2; предиктор v1.3 (k-NN); блок «Почему такой прогноз»; collector v4 без комментариев |
| 17.09.2026 поздний вечер | Предиктор v1.4 (гейт молчащих по freshness > 7 сут); selling-нормировка очередей; «Куда ехать» с гейтом свежести; baseline_restore_at/baseline_error_minutes + TRAINING DATA с bias и разбивками; фильтр/сортировка списка АЗС; живая лента уведомлений; режим UNKNOWN ночью |
| ночь 17→18.09.2026 | Волна 1 (донор Кубань+Адыгея): probe.js → выбор рамки-донора; stations.region; экономная запись доноров; лукбэк 24ч; вьюхи city_events / city_daily_events с bbox; честный ночной заголовок; ось тепловой матрицы 24:00 → 00:00; logTrainingData вынесена в функцию |
| 18.09.2026 | Карта спроса: MapLibre + OpenFreeMap positron, «чистая бумага», зоны/кластеры/пины с тап-полётом и разлётом пинов из центров кластеров |
| ночь 18→19.09.2026 | Сайт v2.5: геолокация и точка «я здесь»; зоны v2 (дышащие кольца, бейдж очереди с плавным переездом к пину); палитра пинов по топливу + градиентные пины + приоритет наложения; таблички названий с логотипом бренда; вылетающие чипы (топливо в цветах палитры, очередь с возрастом и машинами, народные фолбэки, «источник молчит»); кольцо действий в стиле The Sims вместо popup; пузырь быстрой отметки с подтверждением «Спасибо 🙏»; «Показать на карте» и возврат на карту; метрика ① цены города (вьюхи + ряд в карточке); метрика ② покрытие источника (чип со спарклайном + раскрываемый список с полётом); метрика ③ возраст очереди (вьюха эпизодов, чип и полоса в карточке, медиана в дайджесте); queue_age_min в features (предиктор v1.5); шапка панели списка; легенда карты в две строки с заголовками |
| 19.09.2026 | Панель «Наша точность прогнозов» слева от главной с честным нулевым состоянием и эволюцией 3+/10+/100+; стабильность кластеров при панорамировании (ячейки по всем станциям, отрисовка по центру в кадре); гуманизация подзаголовка карты и теглайнов, уборка упоминаний Telegram из панели; «Куда ехать» с расстоянием (штраф min(25, км × 1.5), километры на кнопке) — сайт v2.6 |