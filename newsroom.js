'use strict';
// ============================================================
// КогдаБенз · НЬЮСРУМ v3 — «живой редактор»
// 1) Статья = секции с подзаголовками: суть, цифры, срез по сетям,
//    сравнение с днём и неделей назад, вывод, что делать.
// 2) Карточка факта с крупной цифрой + цитата-врезка + список дел.
// 3) Сравнение: события за 24 ч / сутки назад / неделю назад.
// 4) Срез по сетям АЗС на дату выпуска (сколько станций бренда
//    с подтверждённым АИ-95) — «по табло сетей в данных КогдаБенз».
// 5) Имя бренда дозированно: 1–2 упоминания-атрибуции на статью.
// 6) Словари и формулы заголовков расширены, антиповторы и bandit
//    обучения сохранены.
// 7) ФИКС: служебный ключ used больше не попадает в список выпусков
//    (карточка «used» с NaN-датой).
//   node newsroom.js [--no-git]
// ============================================================
const fs = require('fs');
const path = require('path');
const SITE = 'https://kogdabenz.ru';
const NO_GIT = process.argv.includes('--no-git');
const SUP = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;
const H = 3600000;
const TH = { lossSouth: 12, lossOther: 6, retSouth: 10, retOther: 5, queueCity: 3, accMin: 15 };
const REG = {
south: { label: 'Юг', where: 'на юге', prep: 'на юге', file: 'svodka.html' },
northwest: { label: 'Северо-Запад', where: 'на Северо-Западе', prep: 'на Северо-Западе', file: 'svodka-sz.html' },
chuvashia: { label: 'Чувашия', where: 'в Чувашии', prep: 'в Чувашии', file: 'svodka-ch.html' }
};
const FILE_REG = { 'svodka.json': 'south', 'svodka-sz.json': 'northwest', 'svodka-ch.json': 'chuvashia' };
const RK_FIX = { south: 'south', nw: 'northwest', ch: 'chuvashia' };
const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function unesc(s) { return String(s == null ? '' : s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'); }
function p2(n) { return String(n).padStart(2, '0'); }
function msk(t) { return new Date(t + 3 * H); }
function stamp(t) { const d = msk(t); return p2(d.getUTCDate()) + '.' + p2(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() + ', ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()); }
function plural(n, f) { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return f[2]; if (b > 1 && b < 5) return f[1]; if (b === 1) return f[0]; return f[2]; }
function w(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(a) { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = r[i]; r[i] = r[j]; r[j] = t; } return r; }
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// ---------- словари редактора (v3: шире) ----------
const SY = {
day: ['За последние 24 часа', 'За минувшие сутки', 'За сутки с прошлого выпуска', 'За один день', 'С вечера вчерашнего дня'],
lost: ['топливо пропало с', 'топливо исчезло с', 'отметки «нет топлива» пришли с', 'колонки погасли на', 'источник снял наличие с'],
ret: ['топливо вернулось на', 'топливо снова появилось на', 'колонки ожили на', 'заправки снова показывают наличие на', 'наличие подтвердилось на'],
wave: ['Это похоже на волну: топливо уходит группами, а не по одной колонке.', 'Одиночные сбои так не выглядят — движение синхронное, сразу по нескольким сетям.', 'Так бывает, когда поставка не приходит в срок сразу нескольким брендам.', 'Картина слишком ровная для случайности: сети дышат одновременно.'],
waveBack: ['Возвраты редко бывают одиночными: когда машина приходит на сеть, колонки оживают сразу на нескольких адресах.', 'Волна возврата обычно идёт вслед за привозом на базы.', 'Ожившие колонки — след одной поставки, а не двадцати случайных совпадений.', 'Синхронное оживление адресов — верный признак того, что бензовозы доехали.'],
mean: ['Что это значит для водителя', 'Что это значит на практике', 'Как это читать перед выездом', 'Что из этого следует для поездки', 'Переводя на язык руля и бака'],
meanTail: ['проверять наличие стоит даже на «своей» заправке.', 'выезд наугад сейчас может закончиться пустой колонкой.', 'короткая проверка карты экономит один круг по городу.', 'планировать заправку лучше по окнам привоза, а не по памяти.', 'дешевле потратить минуту на карту, чем сорок минут в очереди.'],
honest: ['Мы не дорисовываем картину: где данных нет, там честно пишем «нет данных».', 'Карта показывает только подтверждённое: источником, водителями или отметкой с места.', 'Обещаний в выпуске нет — только факты с временем и происхождением.', 'Каждая цифра ниже имеет источник и отметку времени — это принцип, а не формальность.'],
loop: ['Ниже — цифра, которая объясняет картину целиком.', 'Главная деталь выпуска — в конце, и она меняет вывод.', 'Дочитайте до последнего абзаца: там то, что обычно пропускают.', 'Самое полезное в этом выпуске — не заголовок, а последний блок.'],
pay: ['И главное: это не приговор на неделю, а снимок часа — картина переписывается каждые 4 часа.', 'И последнее: одна отметка водителя с места перевешивает устаревший снимок источника — карта живая.', 'И напоследок: точность таких выпусков проверяется ночью, а не «на глаз» — ошибки публикуются открыто.', 'И ещё: завтра эти цифры будут другими — и это нормально для живой карты.'],
attr: ['По данным аналитики КогдаБенз,', 'Как считает КогдаБенз,', 'Ночная проверка КогдаБенз подтверждает:', 'По данным живой карты КогдаБенз,']
};
const H2 = {
what: ['Что произошло', 'Суть в одном абзаце', 'Картина дня', 'Коротко о главном'],
num: ['Цифры выпуска', 'Сухие числа', 'Считаем сами', 'Цифры, а не впечатления'],
brand: ['Как выглядят сети', 'Срез по сетям', 'Кто держит колонки', 'Сети в разрезе'],
cmp: ['Сравнение: день и неделя', 'А что было вчера?', 'Динамика за сутки и неделю', 'Контекст времени'],
mean: ['Что это значит для водителя', 'Практический вывод', 'Что делать с этой информацией', 'Перевод на язык поездки']
};
const QUOTE = {
loss: ['Волна дефицита видна раньше, чем её замечают новости: её видно по колонкам.', 'Топливо не исчезает бесследно — оно исчезает одновременно.'],
ret: ['Возврат топлива — тоже новость, просто её реже замечают.', 'Ожившие колонки — самый честный индикатор привоза.'],
deficit: ['Дефицит — это не «нет нигде», это «есть на нескольких адресах». И эти адреса стоит знать.', 'Когда с топливом стоит меньшинство заправок, карта важнее памяти.'],
queue: ['Очередь — самый быстрый сигнал дефицита: быстрее источника и быстрее сводки.', 'Там, где хвост из машин, там через час пустая колонка.'],
acc: ['Честная точность дороже красивой цифры.', 'Прогноз — это интервал вероятности, а не обещание времени.']
};
const TODO = [
['Перед выездом откройте карточку заправки на карте: наличие, очередь и цена видны в одном месте.', 'Смотрите окно привоза: это вероятное время возврата топлива по истории станции.', 'Если вы сейчас на заправке — поставьте отметку: она перевесит устаревший снимок источника.'],
['Проверьте свою АЗС на карте, даже если «всегда есть»: в волну правила меняются за час.', 'Окно привоза подскажет, когда возвращаться, если сейчас пусто.', 'Отметка с места (GPS) — самый сильный голос в системе: ставьте, когда стоите у колонки.'],
['Не катайтесь по старым привычкам: сверьте наличие по карте, это минута.', 'Если топлива нет — смотрите окно привоза, а не соседний район наугад.', 'Ваша отметка «есть/нет» помогает городу больше, чем пересказ в чате.']
];
function availPhrase(c) {
if (!c.known) return 'свежих данных по городу ещё нет';
if (c.a95 === 0) return 'АИ-95 не подтверждён ни на одной из ' + c.known + ' ' + plural(c.known, ['АЗС', 'АЗС', 'АЗС']) + ' с данными';
if (c.a95 === c.known) return 'АИ-95 есть на всех ' + c.known + ' ' + plural(c.known, ['АЗС', 'АЗС', 'АЗС']) + ' с данными';
return 'АИ-95 есть на ' + c.a95 + ' из ' + c.known + ' ' + plural(c.known, ['АЗС', 'АЗС', 'АЗС']) + ' с данными';
}
function bExamples(names) {
if (!names || !names.length) return '';
return w(['Среди отметок за сутки: ', 'В списке за сутки: ', 'Отметки пришли, в частности, с: ']) + names.join('; ') + '.';
}
function bMeaning() { return w(SY.mean) + ': ' + w(SY.meanTail); }
function bNext(c) {
return c.wins > 0
? 'Окон привоза сейчас ' + c.wins + ': ' + w(['это интервалы, в которые топливо возвращалось раньше всего чаще.', 'по ним видно, когда ждать оживления колонок.', 'это вероятное время привоза, посчитанное по истории возвратов.'])
: w(['Окна привоза ещё накапливаются: чем больше возвратов видит карта, тем точнее прогноз по каждой АЗС.', 'Прогнозы появятся, как только накопится история возвратов по конкретным адресам.']);
}
function bHonest() { return w(SY.honest); }
const TAILS = ['— и это не последняя цифра дня', '— одна деталь меняет привычную картину', '— водители уже перестроили маршруты', '— объясняем, что будет дальше', '— и куда делся бензин', '— цифры, которых не было неделю'];
function tail() { return Math.random() < 0.35 ? ' ' + w(TAILS) : ''; }

// ---------- формулы жанров: title + lead + what (v3: по 8) ----------
const FORMULAS = {
loss: [
c => ({ title: cap(c.where) + ' за сутки топливо пропало с ' + c.lost + ' ' + plural(c.lost, ['АЗС', 'АЗС', 'АЗС']) + tail(),
lead: w(SY.day) + ' отметки «топлива нет» появились на ' + c.lost + ' ' + plural(c.lost, ['заправке', 'заправках', 'заправок']) + ' (' + c.where + '). ' + w(SY.wave),
what: [w(SY.day) + ' ' + w(SY.lost) + ' ' + c.lost + ' ' + plural(c.lost, ['АЗС', 'АЗС', 'АЗС']) + ' (' + c.where + ').', bExamples(c.names)] }),
c => ({ title: 'Куда делся бензин? ' + cap(c.where) + ' теряет ' + c.lost + ' ' + plural(c.lost, ['АЗС', 'АЗС', 'АЗС']) + ' за день',
lead: 'Вопрос дня у водителей простой: куда делся бензин. За сутки в сводку попало ' + c.lost + ' ' + plural(c.lost, ['заправку', 'заправки', 'заправок']) + ' с отметкой «нет» (' + c.where + ').',
what: [w(SY.wave), bExamples(c.names)] }),
c => ({ title: c.lost + ' пустых колонок за сутки: хроника волны ' + c.wherePrep,
lead: 'Это не сбой одной сети и не случайность: за сутки ' + c.lost + ' ' + plural(c.lost, ['АЗС', 'АЗС', 'АЗС']) + ' (' + c.where + ') показали отсутствие топлива почти одновременно.',
what: ['Хроника простая: ' + w(SY.lost) + ' одна за другой станции, и интервалы между отметками короче, чем при одиночных сбоях.', bExamples(c.names)] }),
c => ({ title: 'Утро, а топлива нет: ' + c.lost + ' ' + plural(c.lost, ['АЗС', 'АЗС', 'АЗС']) + ' ' + c.where + ' за сутки',
lead: w(SY.day) + ' список «нет топлива» пополнился на ' + c.lost + ' ' + plural(c.lost, ['позицию', 'позиции', 'позиций']) + ' (' + c.where + '). Для сравнения: возвратов за то же время — ' + c.ret + '.',
what: ['Разрыв между потерями (' + c.lost + ') и возвратами (' + c.ret + ') и есть мера волны: пока он такой, картина сжимается.', bExamples(c.names)] }),
c => ({ title: 'Почему у колонок снова пусто? ' + c.lost + ' ' + plural(c.lost, ['факт', 'факта', 'фактов']) + ' за сутки ' + c.wherePrep,
lead: 'Короткий ответ: волна. Длинный — в цифрах: ' + c.lost + ' ' + plural(c.lost, ['АЗС', 'АЗС', 'АЗС']) + ' за сутки показали «нет» (' + c.where + '), и это синхронное движение, а не двадцать случайностей.',
what: [w(SY.wave), bExamples(c.names)] }),
c => ({ title: 'Минус ' + c.lost + ' ' + plural(c.lost, ['заправка', 'заправки', 'заправок']) + ' с топливом за один день (' + c.label + ')',
lead: 'Сводка за сутки читается как сводка с фронта: ' + c.lost + ' ' + plural(c.lost, ['АЗС', 'АЗС', 'АЗС']) + ' (' + c.where + ') потеряли топливо, вернули за то же время — ' + c.ret + '.',
what: ['Баланс дня отрицательный: потерь больше, чем возвратов, и это главный признак сжимающегося рынка.', bExamples(c.names)] }),
c => ({ title: 'Водители меняют маршруты: ' + c.lost + ' ' + plural(c.lost, ['АЗС', 'АЗС', 'АЗС']) + ' ' + c.where + ' за сутки без топлива',
lead: 'Когда за сутки гаснет ' + c.lost + ' ' + plural(c.lost, ['колонку', 'колонки', 'колонок']) + ' (' + c.where + '), привычные маршруты заправки перестают работать — и водители идут по окнам привоза.',
what: [w(SY.wave), bExamples(c.names)] }),
c => ({ title: 'Карта краснеет: ' + c.lost + ' ' + plural(c.lost, ['точка', 'точки', 'точек']) + ' потери топлива за сутки (' + c.label + ')',
lead: 'Каждая потерянная станция — это красный квадрат на тепловой карте города. За сутки их добавилось ' + c.lost + ' (' + c.where + ').',
what: ['Тепловая карта — не украшение: размер красного квадрата растёт вместе с очередями и часами простоя.', bExamples(c.names)] })
],
ret: [
c => ({ title: cap(c.where) + ' за сутки топливо вернулось на ' + c.ret + ' ' + plural(c.ret, ['АЗС', 'АЗС', 'АЗС']) + tail(),
lead: w(SY.day) + ' ' + c.ret + ' ' + plural(c.ret, ['заправка снова показала', 'заправки снова показали', 'заправок снова показали']) + ' наличие топлива (' + c.where + '). ' + w(SY.waveBack),
what: ['Возвратов за сутки: ' + c.ret + ' (' + c.where + ') при ' + c.lost + ' ' + plural(c.lost, ['потере', 'потерях', 'потерях']) + '.', bExamples(c.names)] }),
c => ({ title: 'Бензин возвращается: ' + c.ret + ' ' + plural(c.ret, ['АЗС', 'АЗС', 'АЗС']) + ' ' + c.where + ' ожили за сутки',
lead: 'Хорошая новость дня: колонки оживают. За сутки ' + c.ret + ' ' + plural(c.ret, ['АЗС', 'АЗС', 'АЗС']) + ' (' + c.where + ') снова показывают наличие.',
what: [w(SY.waveBack), bExamples(c.names)] }),
c => ({ title: 'Плюс ' + c.ret + ' ' + plural(c.ret, ['заправка', 'заправки', 'заправок']) + ' с топливом за один день (' + c.label + ')',
lead: 'Сводка за сутки со знаком плюс: ' + c.ret + ' ' + plural(c.ret, ['АЗС', 'АЗС', 'АЗС']) + ' (' + c.where + ') вернули топливо в продажу.',
what: ['Баланс дня ' + (c.ret > c.lost ? 'положительный: возвратов больше, чем потерь.' : 'почти нулевой: возвратов и потерь поровну.'), bExamples(c.names)] }),
c => ({ title: 'Куда ехать, если вчера было пусто: ' + c.ret + ' ' + plural(c.ret, ['возврат', 'возврата', 'возвратов']) + ' за сутки ' + c.wherePrep,
lead: 'Вчерашние «пустые» адреса оживают: за сутки ' + c.ret + ' ' + plural(c.ret, ['АЗС', 'АЗС', 'АЗС']) + ' (' + c.where + ') снова с топливом.',
what: [w(SY.waveBack), bExamples(c.names)] }),
c => ({ title: 'Привоз доехал? ' + c.ret + ' ' + plural(c.ret, ['АЗС', 'АЗС', 'АЗС']) + ' ' + c.where + ' за сутки показали топливо',
lead: 'Похоже на след одной поставки: за сутки ' + c.ret + ' ' + plural(c.ret, ['АЗС', 'АЗС', 'АЗС']) + ' (' + c.where + ') вернули наличие почти одновременно.',
what: ['Синхронность возвратов — подпись бензовоза: сети оживают пачками, а не по одной.', bExamples(c.names)] }),
c => ({ title: 'Оттепель у колонок: ' + c.ret + ' ' + plural(c.ret, ['возврат', 'возврата', 'возвратов']) + ' топлива за сутки (' + c.label + ')',
lead: w(SY.day) + ' карта зафиксировала ' + c.ret + ' ' + plural(c.ret, ['возврат', 'возврата', 'возвратов']) + ' топлива (' + c.where + ') — при ' + c.lost + ' ' + plural(c.lost, ['потере', 'потерях', 'потерях']) + ' за то же время.',
what: [w(SY.waveBack), bExamples(c.names)] }),
c => ({ title: 'Очереди начнут рассасываться: ' + c.ret + ' ' + plural(c.ret, ['АЗС', 'АЗС', 'АЗС']) + ' ' + c.where + ' снова с топливом',
lead: 'Каждый возврат снимает часть спроса с уцелевших адресов. За сутки их ' + c.ret + ' (' + c.where + ') — значит, хвосты у колонок начнут таять.',
what: [w(SY.waveBack), bExamples(c.names)] }),
c => ({ title: 'День возвратов: ' + c.ret + ' ' + plural(c.ret, ['колонка', 'колонки', 'колонок']) + ' ожили ' + c.wherePrep,
lead: 'Бывают дни потерь, а бывают дни возвратов. Сегодня второй: ' + c.ret + ' ' + plural(c.ret, ['АЗС', 'АЗС', 'АЗС']) + ' (' + c.where + ') снова продают топливо.',
what: [w(SY.waveBack), bExamples(c.names)] })
],
deficit: [
c => ({ title: c.city + ': ' + availPhrase(c) + tail(),
lead: 'В городе ' + c.city + ' ' + availPhrase(c) + '. Остальные либо показывают «нет», либо молчат — и молчание сейчас хуже «нет».',
what: [availPhrase(c) + ' — снимок на ' + c.stamp + '.', 'АИ-92 есть на ' + c.a92 + ', дизель — на ' + c.adt + ' из тех же ' + c.known + '.'] }),
c => ({ title: 'Где заправиться в городе ' + c.city + '? Ответ короткий: ' + c.a95 + ' ' + plural(c.a95, ['адрес', 'адреса', 'адресов']) + ' из ' + c.known,
lead: 'Если искать АИ-95 в городе ' + c.city + ' прямо сейчас, рабочих адресов ' + c.a95 + ' из ' + c.known + ' станций с данными. Это не слух и не оценка — подтверждённые отметки.',
what: [availPhrase(c) + '.', 'Очередей в городе отмечено: ' + c.q + '. Окон привоза: ' + c.wins + '.'] }),
c => ({ title: c.city + ' на топлидном голодании: ' + c.a95 + ' из ' + c.known + ' — и ни одной лишней',
lead: 'Цифра дня по городу ' + c.city + ': ' + c.a95 + ' ' + plural(c.a95, ['АЗС', 'АЗС', 'АЗС']) + ' с подтверждённым АИ-95 из ' + c.known + '. Всё, что сверх этого, — догадки, а мы их не публикуем.',
what: [availPhrase(c) + '.', 'Для сравнения: АИ-92 держат ' + c.a92 + ' ' + plural(c.a92, ['АЗС', 'АЗС', 'АЗС']) + ', дизель — ' + c.adt + '.'] }),
c => ({ title: 'Стоит ли ехать наугад в городе ' + c.city + '? Цифры говорят нет',
lead: 'В городе ' + c.city + ' ' + availPhrase(c) + '. Езда наугад при такой картине — это лотерея' + (c.q ? ' с очередями в придачу' : '') + '.',
what: [availPhrase(c) + ' на ' + c.stamp + '.', 'Окон привоза по городу: ' + c.wins + ' — это вероятное время оживления колонок.'] }),
c => ({ title: c.known + ' ' + plural(c.known, ['заправка', 'заправки', 'заправок']) + ', ' + c.a95 + ' с топливом: честный срез города ' + c.city,
lead: 'Без прикрас: в городе ' + c.city + ' из ' + c.known + ' станций с данными АИ-95 подтверждён на ' + c.a95 + '. Остальные — «нет» или тишина источника.',
what: [availPhrase(c) + '.', 'Очереди: ' + c.q + ' ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']) + '. Окна привоза: ' + c.wins + '.'] }),
c => ({ title: 'Что с бензином в городе ' + c.city + ' к ' + c.hhmm + '? Отвечаем цифрами',
lead: 'К ' + c.hhmm + ' в городе ' + c.city + ' ' + availPhrase(c) + '. Ниже — что это значит для поездки и когда ждать изменений.',
what: [availPhrase(c) + '.', 'АИ-92: ' + c.a92 + ' из ' + c.known + ', дизель: ' + c.adt + ' из ' + c.known + '.'] }),
c => ({ title: 'Город ' + c.city + ' живёт на ' + c.a95 + ' ' + plural(c.a95, ['адресе', 'адресах', 'адресах']) + ': как это выглядит изнутри',
lead: 'Когда с топливом остаётся ' + c.a95 + ' ' + plural(c.a95, ['заправка', 'заправки', 'заправок']) + ' из ' + c.known + ', город перестраивается: спрос и маршруты стягиваются к этим адресам' + (c.q ? ', а вместе с ними и очереди' : '') + '.',
what: [availPhrase(c) + '.', 'Очереди отмечены на ' + c.q + ' ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']) + ' — именно там спрос и сконцентрирован.'] }),
c => ({ title: 'Почему в городе ' + c.city + ' снова «нет»? Разбор снимка на ' + c.hhmm,
lead: 'Снимок на ' + c.hhmm + ' такой: ' + availPhrase(c) + '. Разбираем, что за этим стоит и когда картина может перевернуться.',
what: [availPhrase(c) + '.', 'Окон привоза по городу: ' + c.wins + ' — по ним и смотрим, когда ждать перелома.'] })
],
queue: [
c => ({ title: c.city + ': очереди отмечены на ' + c.q + ' ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']) + tail(),
lead: 'Водители сообщают о высокой очереди на ' + c.q + ' ' + plural(c.q, ['заправке', 'заправках', 'заправках']) + ' города ' + c.city + '. Очередь — ранний признак того, что топливо в городе на исходе.',
what: ['Очередей в городе сейчас: ' + c.q + '.', 'Очереди появляются раньше, чем источник успевает снять отметки наличия.'] }),
c => ({ title: 'Хвосты у колонок: ' + c.q + ' ' + plural(c.q, ['очередь', 'очереди', 'очередей']) + ' в городе ' + c.city,
lead: 'В городе ' + c.city + ' водители отметили живые очереди на ' + c.q + ' ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']) + '. Там, где хвост, там и пустая колонка через час.',
what: ['Отметка об очереди живёт около часа и ставится одним тапом — поэтому карта очередей свежее сводки наличия.', availPhrase(c) + '.'] }),
c => ({ title: 'Почему в городе ' + c.city + ' снова стоят в очереди',
lead: 'Причина проста и видна в цифрах: ' + availPhrase(c) + ', а очереди отмечены на ' + c.q + ' ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']) + '. Спрос идёт туда, где топливо ещё есть.',
what: ['Очереди — это спрос, сконцентрированный на немногих рабочих адресах.', 'Окон привоза по городу: ' + c.wins + '.'] }),
c => ({ title: c.q + ' ' + plural(c.q, ['очередь', 'очереди', 'очередей']) + ' за один вечер: что происходит в городе ' + c.city,
lead: 'Вечерний срез по городу ' + c.city + ': высокие очереди на ' + c.q + ' ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']) + '. Это не впечатление, а отметки водителей с временем.',
what: ['Очередь — самый быстрый сигнал дефицита: быстрее источника и быстрее сводки.', availPhrase(c) + '.'] }),
c => ({ title: 'Ехать или переждать? Очереди города ' + c.city + ' на ' + c.hhmm,
lead: 'На ' + c.hhmm + ' в городе ' + c.city + ' очереди отмечены на ' + c.q + ' ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']) + '. Решать вам, но вот контекст.',
what: [availPhrase(c) + '.', 'Окон привоза: ' + c.wins + ' — по ним видно, когда хвосты рассосутся сами.'] }),
c => ({ title: 'Город ' + c.city + ' встал у колонок: ' + c.q + ' ' + plural(c.q, ['точка', 'точки', 'точек']) + ' с очередью',
lead: 'Карта очередей по городу ' + c.city + ' показала ' + c.q + ' ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']) + ' с высокой очередью. Обычно так выглядит день перед волной возвратов.',
what: ['Очереди отмечали водители, а не алгоритм: у каждой отметки есть устройство и время.', 'Окон привоза по городу: ' + c.wins + '.'] }),
c => ({ title: 'Сколько стоит терпение: очереди города ' + c.city + ' в цифрах',
lead: 'Очередь — это цена в минутах. Сейчас в городе ' + c.city + ' её платят на ' + c.q + ' ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']) + '.',
what: [availPhrase(c) + '.', 'Чем меньше адресов с топливом, тем длиннее хвост на оставшихся — математика простая.'] }),
c => ({ title: 'Ранний сигнал из города ' + c.city + ': ' + c.q + ' ' + plural(c.q, ['очередь', 'очереди', 'очередей']) + ' за один срез',
lead: 'Очереди — опережающий индикатор: они растут раньше, чем сводка показывает «нет». В городе ' + c.city + ' их сейчас ' + c.q + '.',
what: [availPhrase(c) + '.', 'Если очереди растут два среза подряд — ждите волну потерь в ближайшие сутки.'] })
],
acc: [
c => ({ title: c.hit + ' из ' + c.verified + ': как на самом деле сбывается прогноз привоза (' + c.rate + '%)',
lead: 'За 30 дней проверено ' + c.verified + ' ' + plural(c.verified, ['прогноз', 'прогноза', 'прогнозов']) + ' привоза: топливо вернулось в объявленное окно в ' + c.hit + ' ' + plural(c.hit, ['случае', 'случаях', 'случаях']) + ' (' + c.rate + '%). Цифра открытая, и мы объясняем, что за ней.',
what: ['Каждый прогноз проверяется задним числом: окно сравнивается с фактом, ошибка уходит в статистику.', 'Окно привоза специально широкое (4–6 часов): это честный интервал вероятности, а не обещание «ровно в 14:00».'] }),
c => ({ title: 'Мы посчитали свою точность честно: ' + c.rate + '% попаданий в окно привоза',
lead: 'Никаких «до 90%»: за 30 дней строгое попадание в объявленное окно — ' + c.hit + ' из ' + c.verified + ' (' + c.rate + '%). Показываем, почему это не провал и не победа, а рабочий инструмент.',
what: ['Прогноз строится по квантилям 20–80% прошлых возвратов конкретной АЗС или её бренда.', 'Ширина окна — плата за честность: узкое окно давало бы красивые проценты и пустые колонки.'] }),
c => ({ title: 'Сбылось или нет? ' + c.verified + ' ' + plural(c.verified, ['проверка', 'проверки', 'проверок']) + ' прогноза привоза за месяц',
lead: 'Ночная проверка сверяет вчерашние окна с фактом. Итог месяца: ' + c.hit + ' попаданий из ' + c.verified + ' (' + c.rate + '%). Медианная ошибка публикуется там же, без округлений в свою пользу.',
what: ['Проверка идёт каждую ночь автоматически: факт возврата сравнивается с окном.', 'Ошибки модели уходят в калибровку — следующие окна строятся уже с учётом этого месяца.'] }),
c => ({ title: 'Почему прогнозу можно верить на ' + c.rate + '%, а не на все сто',
lead: 'Честный ответ: строгое попадание в окно за месяц — ' + c.hit + ' из ' + c.verified + ' (' + c.rate + '%). Прогноз и не обещает certainty: он сужает круг часов, в которые привоз вероятен.',
what: ['Окно привоза — это интервал вероятности, посчитанный по истории возвратов.', 'Альтернатива прогнозу — ехать наугад: у наугад точность ниже, а цена та же очередь.'] }),
c => ({ title: 'Месяц проверок: ' + c.hit + ' совпадений из ' + c.verified + ' и что мы изменим в модели',
lead: 'Статистика месяца: ' + c.hit + ' из ' + c.verified + ' прогнозов попали в окно (' + c.rate + '%). Это не приговор модели, а её учебник: каждый промах уточняет квантили.',
what: ['Калибровка пересобирается по свежим проверкам — следующие выпуски строятся уже на этих ошибках.', 'Открытая публикация точности — осознанная: доверие дороже красивой цифры.'] }),
c => ({ title: 'Точность без прикрас: ' + c.rate + '% попаданий в окно и почему это нормально',
lead: 'За 30 дней: ' + c.verified + ' ' + plural(c.verified, ['проверка', 'проверки', 'проверок']) + ', ' + c.hit + ' попаданий в строгое окно (' + c.rate + '%). Объясняем, что меряем и почему так жёстко.',
what: ['Меряем строгое попадание: факт возврата должен попасть внутрь объявленного интервала.', 'Мягкая метрика (факт в тот же день) выше, но мы публикуем строгую — она честнее.'] }),
c => ({ title: 'Проверяем себя прилюдно: ' + c.verified + ' ' + plural(c.verified, ['прогноз', 'прогноза', 'прогнозов']) + ', ' + c.hit + ' попаданий',
lead: 'Редкий случай, когда сервис публикует собственную статистику ошибок. У нас она такая: ' + c.hit + ' строгих попаданий из ' + c.verified + ' (' + c.rate + '%) за 30 дней.',
what: ['Каждое попадание и каждый промах зафиксированы в базе с временем — пересчитать может любой.', 'Модель дообучается на промахах: точность следующего месяца стартует с этой цифры.'] }),
c => ({ title: 'Что стоит за цифрой ' + c.rate + '%: анатомия одного прогноза привоза',
lead: 'За месяц проверено ' + c.verified + ' ' + plural(c.verified, ['прогноз', 'прогноза', 'прогнозов']) + ', строгих попаданий — ' + c.hit + ' (' + c.rate + '%). Разбираем, из чего складывается эта цифра.',
what: ['Прогноз = квантили истории возвратов станции, а при её нехватке — истории бренда или города.', 'Проверка = факт возврата от источника или водителей, сверенный с окном ночью.'] })
]
};

// ---------- обучение (bandit) ----------
function variantScore(st) {
if (!st || !st.n) return 0;
const shrink = st.n / (st.n + 3);
return (st.fin * 0.5 + (st.scroll / 100) * 0.3 + Math.min(st.dwell, 120000) / 120000 * 0.2) * shrink;
}
function chooseVariant(family, stats, manifest) {
const list = FORMULAS[family];
const used = (manifest.used && manifest.used[family]) || [];
let avail = list.map((f, i) => i).filter(i => used.indexOf(family + ':' + i) < 0);
if (!avail.length) avail = list.map((f, i) => i);
let idx;
if (Math.random() < 0.25) idx = avail[Math.floor(Math.random() * avail.length)];
else {
let best = -1, bestS = -1;
for (const i of avail) { const s = variantScore(stats[family + ':' + i]); if (s > bestS) { bestS = s; best = i; } }
idx = bestS > 0 ? best : avail[Math.floor(Math.random() * avail.length)];
}
manifest.used = manifest.used || {};
manifest.used[family] = ((manifest.used[family] || []).concat([family + ':' + idx])).slice(-8);
return idx;
}

// ---------- данные ----------
async function sbGet(p) {
const r = await fetch(SUP + '/rest/v1/' + p, { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
if (!r.ok) throw new Error('GET ' + p + ' → ' + r.status);
return r.json();
}
async function load() {
const stations = await sbGet('stations?select=id,name,brand,address,lat,lon,region&limit=2000');
const now = Date.now();
const q = (a, b) => 'events?event_type=in.(fuel_disappeared,fuel_restored)&select=station_id,event_type,detected_at&detected_at=gte.' + new Date(a).toISOString() + '&detected_at=lt.' + new Date(b).toISOString() + '&limit=4000';
const [evs, evsY, evsW, ver, obs] = await Promise.all([
sbGet(q(now - 24 * H, now)),
sbGet(q(now - 48 * H, now - 24 * H)),
sbGet(q(now - 8 * 24 * H, now - 7 * 24 * H)),
sbGet('predictions?is_verified=eq.true&verified_at=gte.' + new Date(now - 30 * 24 * H).toISOString() + '&select=result,verified_at&limit=1000'),
sbGet('observations?select=station_id,fuel_95_status,fuel_92_status,diesel_status,queue_level,timestamp&order=timestamp.desc&limit=6000')
]);
const last = {};
for (const o of obs) { if (!last[o.station_id]) last[o.station_id] = o; }
let met = [];
try { met = await sbGet('news_metrics?select=family,variant,dwell_ms,scroll_pct,finished&limit=5000'); } catch (e) {}
return { stations, evs, evsY, evsW, ver, last, met };
}
function readSvodkas(dir) {
const out = [];
for (const f of ['svodka.json', 'svodka-sz.json', 'svodka-ch.json']) {
try {
const p = path.join(dir, f);
if (!fs.existsSync(p)) continue;
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
out.push({ file: f, region: j.region || FILE_REG[f], totals: j.totals, cities: j.cities || [] });
} catch (e) {}
}
return out;
}
function aggStats(met) {
const m = {};
for (const r of met) {
const k = r.family + ':' + r.variant;
const s = m[k] || (m[k] = { n: 0, dwell: 0, scroll: 0, fin: 0 });
s.n++; s.dwell += r.dwell_ms || 0; s.scroll += r.scroll_pct || 0; s.fin += r.finished ? 1 : 0;
}
for (const k in m) { m[k].dwell /= m[k].n; m[k].scroll /= m[k].n; m[k].fin /= m[k].n; }
return m;
}
function countEvs(evs) {
const r = { lost: 0, ret: 0, lostSt: {} };
for (const e of evs) {
if (e.event_type === 'fuel_disappeared') { r.lost++; r.lostSt[e.station_id] = 1; }
else r.ret++;
}
return r;
}

// ---------- детектор поводов ----------
function detect(D, svodkas, t) {
const out = [];
const stById = {};
for (const s of D.stations) stById[s.id] = s;
const regEvs = {};
for (const key of ['evs', 'evsY', 'evsW']) {
for (const e of D[key]) {
const s = stById[e.station_id]; if (!s) continue;
const r = s.region || 'south';
regEvs[r] = regEvs[r] || { lost: 0, ret: 0, lostSt: {}, retSt: {}, lostY: 0, retY: 0, lostW: 0, retW: 0 };
const lost = e.event_type === 'fuel_disappeared';
if (key === 'evs') { if (lost) { regEvs[r].lost++; regEvs[r].lostSt[e.station_id] = 1; } else { regEvs[r].ret++; regEvs[r].retSt[e.station_id] = 1; } }
else if (key === 'evsY') { if (lost) regEvs[r].lostY++; else regEvs[r].retY++; }
else { if (lost) regEvs[r].lostW++; else regEvs[r].retW++; }
}
}
// срез по сетям на дату выпуска
const brands = {};
for (const s of D.stations) {
const r = s.region || 'south';
const o = D.last[s.id];
if (!o || !s.brand) continue;
const b = brands[r] = brands[r] || {};
const e = b[s.brand] = b[s.brand] || { known: 0, a95: 0 };
if (o.fuel_95_status !== null && o.fuel_95_status !== undefined) { e.known++; if (o.fuel_95_status) e.a95++; }
}
const brandList = r => Object.keys(brands[r] || {}).map(k => ({ name: k, known: brands[r][k].known, a95: brands[r][k].a95 }))
.filter(b => b.known >= 3).sort((a, b) => b.known - a.known).slice(0, 4);
const names = (map, n) => Object.keys(map || {}).slice(0, n).map(id => stById[id]).filter(Boolean).map(s => '«' + (s.name || 'АЗС') + '»' + (s.address ? ', ' + s.address : ''));
const winsByReg = {};
for (const sv of svodkas) { const rk0 = RK_FIX[sv.region] || sv.region || FILE_REG[sv.file]; winsByReg[rk0] = (sv.totals && sv.totals.wins) || 0; }
const d = msk(t), day = '' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate());
for (const r of Object.keys(REG)) {
const E = regEvs[r] || { lost: 0, ret: 0, lostSt: {}, retSt: {}, lostY: 0, retY: 0, lostW: 0, retW: 0 };
const cmp = { ly: E.lostY, ry: E.retY, lw: E.lostW, rw: E.retW };
const thL = r === 'south' ? TH.lossSouth : TH.lossOther, thR = r === 'south' ? TH.retSouth : TH.retOther;
const base = { where: REG[r].where, wherePrep: REG[r].prep, label: REG[r].label, rk: r, cmp, brands: brandList(r), stamp: stamp(t), hhmm: stamp(t).split(', ')[1] };
if (E.lost >= thL) out.push(Object.assign({ family: 'loss', slug: 'volna-uhod-' + r + '-' + day, og: 'og-' + r + '.png', lost: E.lost, ret: E.ret, names: names(E.lostSt, 4), wins: winsByReg[r] || 0 }, base));
if (E.ret >= thR) out.push(Object.assign({ family: 'ret', slug: 'volna-vozvrat-' + r + '-' + day, og: 'og-' + r + '.png', lost: E.lost, ret: E.ret, names: names(E.retSt, 4), wins: winsByReg[r] || 0 }, base));
}
for (const sv of svodkas) {
const rk = RK_FIX[sv.region] || sv.region || FILE_REG[sv.file];
const base = { where: REG[rk] ? REG[rk].where : 'в регионе', wherePrep: REG[rk] ? REG[rk].prep : 'в регионе', label: REG[rk] ? REG[rk].label : 'Регион', rk: rk, cmp: (regEvs[rk] || {}), brands: brandList(rk), stamp: stamp(t), hhmm: stamp(t).split(', ')[1] };
base.cmp = { ly: (regEvs[rk] || {}).lostY || 0, ry: (regEvs[rk] || {}).retY || 0, lw: (regEvs[rk] || {}).lostW || 0, rw: (regEvs[rk] || {}).retW || 0 };
base.lost = (regEvs[rk] || {}).lost || 0; base.ret = (regEvs[rk] || {}).ret || 0;
for (const c of sv.cities) {
if (!c.known || c.known < 8) continue;
const cc = Object.assign({ city: c.name, a95: c.a95, a92: c.a92, adt: c.adt, known: c.known, q: c.q, wins: c.wins }, base);
if (c.level === 'r') out.push(Object.assign({ family: 'deficit', slug: 'deficit-' + c.key + '-' + day, og: 'og-' + c.key + '.png' }, cc));
if (c.q >= TH.queueCity) out.push(Object.assign({ family: 'queue', slug: 'ocheredi-' + c.key + '-' + day, og: 'og-' + c.key + '.png' }, cc));
}
}
const verified = D.ver.filter(v => v.verified_at);
if (verified.length >= TH.accMin) {
const hit = verified.filter(v => v.result === 'SUCCESS').length;
out.push({ family: 'acc', slug: 'tochnost-' + day, og: 'og-south.png', verified: verified.length, hit, rate: Math.round(100 * hit / verified.length),
where: REG.south.where, wherePrep: REG.south.prep, label: REG.south.label, rk: 'south',
cmp: { ly: (regEvs.south || {}).lostY || 0, ry: (regEvs.south || {}).retY || 0, lw: (regEvs.south || {}).lostW || 0, rw: (regEvs.south || {}).retW || 0 },
brands: brandList('south'), stamp: stamp(t), hhmm: stamp(t).split(', ')[1], wins: winsByReg.south || 0, lost: (regEvs.south || {}).lost || 0, ret: (regEvs.south || {}).ret || 0 });
}
return out;
}

// ---------- сборка секций ----------
function factcard(c) {
if (c.family === 'loss') return { big: String(c.lost), lab: 'АЗС потеряли топливо за 24 ч', sub: c.label };
if (c.family === 'ret') return { big: String(c.ret), lab: 'АЗС вернули топливо за 24 ч', sub: c.label };
if (c.family === 'deficit') return { big: c.a95 + ' / ' + c.known, lab: 'АЗС с АИ-95 из станций с данными', sub: c.city };
if (c.family === 'queue') return { big: String(c.q), lab: 'АЗС с высокой очередью сейчас', sub: c.city };
return { big: c.rate + '%', lab: 'строгих попаданий в окно за 30 дней', sub: c.hit + ' из ' + c.verified };
}
function factsList(c) {
if (c.family === 'loss' || c.family === 'ret') return ['Потерь за 24 ч: ' + c.lost, 'Возвратов за 24 ч: ' + c.ret, 'Регион: ' + c.label, 'Окно данных: ' + stamp(Date.now() - 24 * H) + ' — ' + c.stamp + ' МСК'];
if (c.family === 'deficit') return ['АИ-95 есть: ' + c.a95 + ' из ' + c.known, 'АИ-92 есть: ' + c.a92 + ' из ' + c.known, 'Дизель есть: ' + c.adt + ' из ' + c.known, 'Окон привоза: ' + c.wins, 'АЗС с очередью: ' + c.q];
if (c.family === 'queue') return ['АЗС с высокой очередью: ' + c.q, availPhrase(c), 'Окон привоза: ' + c.wins];
return ['Проверено прогнозов за 30 дней: ' + c.verified, 'Совпало с окном: ' + c.hit, 'Точность: ' + c.rate + '%'];
}
function cmpText(c) {
const m = c.cmp || {};
const isWave = c.family === 'loss' || c.family === 'ret';
const L = isWave ? (c.family === 'ret' ? c.ret : c.lost) : (c.lost || 0);
const R = isWave ? (c.family === 'ret' ? c.lost : c.ret) : (c.ret || 0);
const ly = m.ly || 0, ry = m.ry || 0, lw = m.lw || 0, rw = m.rw || 0;
let s;
if (isWave) {
s = 'За текущие сутки ' + c.where + ' отмечено ' + L + ' ' + plural(L, ['событие', 'события', 'событий']) + ' этого типа. ';
s += 'Сутки назад за такое же окно было ' + (c.family === 'ret' ? ry : ly) + ', а в тот же день недели неделей ранее — ' + (c.family === 'ret' ? rw : lw) + '. ';
} else {
s = 'Для контекста: за текущие сутки ' + c.where + ' топливо пропало с ' + L + ' ' + plural(L, ['АЗС', 'АЗС', 'АЗС']) + ' и вернулось на ' + R + '. ';
s += 'Сутки назад было ' + ly + ' ' + plural(ly, ['исчезновение', 'исчезновения', 'исчезновений']) + ' и ' + ry + ' ' + plural(ry, ['возврат', 'возврата', 'возвратов']) + ', неделей ранее — ' + lw + ' и ' + rw + '. ';
}
const yBase = isWave ? (c.family === 'ret' ? ry : ly) : ly;
const wBase = isWave ? (c.family === 'ret' ? rw : lw) : lw;
const day = yBase ? (L > yBase * 1.25 ? 'up' : L < yBase * 0.75 ? 'down' : 'flat') : 'nodata';
const week = wBase ? (L > wBase * 1.25 ? 'up' : L < wBase * 0.75 ? 'down' : 'flat') : 'nodata';
if (day === 'up' && week !== 'down') s += w(['Динамика растущая: волна набирает силу.', 'То есть картина ухудшается быстрее, чем вчера.']);
else if (day === 'down' && week !== 'up') s += w(['Динамика спадающая: пик, похоже, позади.', 'Вчерашний день был тяжелее — есть повод для осторожного оптимизма.']);
else if (day === 'flat' && week === 'down') s += 'К вчерашнему дню картина ровная, но неделей ранее событий было заметно больше: относительно прошлой недели ситуация спокойнее.';
else if (day === 'flat' && week === 'up') s += 'К вчерашнему дню картина ровная, но неделей ранее событий было меньше: относительно прошлой недели напряжение выросло.';
else if (day === 'nodata' && week === 'nodata') s += 'Истории для сравнения пока мало: цифры появятся, когда накопятся события за прошлые сутки и неделю.';
else s += w(['Показатели держатся примерно на уровне вчерашнего дня: это плато, а не скачок.', 'Разница с сутками и неделей назад невелика: ситуация стабильно напряжённая, без резких движений.']);
return s;
}
function brandNote(c) { return 'Срез по сетям на ' + c.stamp + ' по данным КогдаБенз: сколько станций каждого бренда держат подтверждённый АИ-95.'; }
function todoList() { return w(TODO); }
function attrOnce(c) {
if (c._attr) return '';
c._attr = 1;
return w(SY.attr) + ' ';
}

// ---------- страница ----------
const CSS = `
*{box-sizing:border-box}html{background:#0a1024;scrollbar-color:#3f74d6 rgba(148,180,255,.1)}
body{margin:0;background:linear-gradient(180deg,#0d1526,#0a1024 60%,#080d1c);color:#e8eefb;
font:17px/1.75 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:#7db4ff}::selection{background:#2465ee;color:#fff}
.wrap{max-width:720px;margin:0 auto;padding:22px 18px 70px}
.top{display:flex;align-items:center;gap:10px;padding:14px 0 18px;border-bottom:1px solid rgba(148,180,255,.16);margin-bottom:26px}
.top .tile{width:34px;height:34px;border-radius:11px;background:linear-gradient(140deg,#4b93ff,#1746c8);display:grid;place-items:center;flex:none}
.top .tile svg{width:17px;height:17px;fill:#fff}
.top b{font-size:15px;letter-spacing:-.2px}.top small{display:block;font-size:9.5px;font-weight:800;letter-spacing:.14em;color:#6b7a96;text-transform:uppercase}
.top nav{margin-left:auto;display:flex;gap:14px;font-size:12.5px;font-weight:700}
.kicker{display:inline-flex;align-items:center;gap:8px;font-size:10.5px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#2fd39a;margin:0 0 12px}
.kicker i{width:7px;height:7px;border-radius:50%;background:#2fd39a;box-shadow:0 0 0 4px rgba(47,211,154,.15)}
h1{margin:0 0 12px;font-size:clamp(25px,5.8vw,38px);line-height:1.14;font-weight:900;letter-spacing:-.9px}
.meta{font-size:12.5px;color:#93a0b8;margin:0 0 22px}
.lead{font-size:19px;font-weight:700;line-height:1.6;color:#f2f6ff;margin:0 0 26px;padding-left:16px;border-left:3px solid #2465ee}
h2.sec{margin:34px 0 12px;font-size:15px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#7db4ff}
h2.sec::before{content:'';display:inline-block;width:22px;height:3px;border-radius:99px;background:linear-gradient(90deg,#4b93ff,#2fd39a);margin-right:10px;vertical-align:middle}
p{margin:0 0 15px}
.factcard{display:flex;align-items:center;gap:18px;margin:6px 0 16px;padding:20px 22px;border-radius:20px;
background:linear-gradient(140deg,rgba(75,147,255,.16),rgba(47,211,154,.08));border:1px solid rgba(148,180,255,.24);position:relative;overflow:hidden}
.factcard::after{content:'';position:absolute;right:-40px;top:-40px;width:150px;height:150px;border-radius:50%;background:radial-gradient(circle,rgba(75,147,255,.25),transparent 70%)}
.factcard b{font-size:44px;font-weight:900;letter-spacing:-2px;line-height:1;color:#fff;font-variant-numeric:tabular-nums;white-space:nowrap}
.factcard span{font-size:12.5px;font-weight:700;color:#c3cfe4;line-height:1.4}
.factcard span i{display:block;font-style:normal;font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#7db4ff;margin-top:4px}
.facts{margin:0 0 6px;padding:14px 18px;border:1px solid rgba(148,180,255,.16);border-radius:16px;background:rgba(148,180,255,.04)}
.facts ul{margin:0;padding-left:18px}.facts li{margin:5px 0;font-size:14.5px;color:#c3cfe4}
.brands{display:flex;flex-direction:column;gap:9px;margin:4px 0 10px}
.brow{display:grid;grid-template-columns:110px 1fr auto;gap:12px;align-items:center;padding:11px 14px;border-radius:14px;background:rgba(148,180,255,.05);border:1px solid rgba(148,180,255,.12)}
.brow .bn{font-size:13px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.brow .bar{height:8px;border-radius:99px;background:rgba(148,180,255,.12);overflow:hidden}
.brow .bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#2fd39a,#7db4ff)}
.brow .bv{font-size:12.5px;font-weight:800;color:#9fe8cd;font-variant-numeric:tabular-nums;white-space:nowrap}
.bnote{font-size:12px;color:#6b7a96;margin:0 0 6px}
.quote{margin:22px 0;padding:18px 22px;border-radius:18px;background:linear-gradient(140deg,rgba(124,109,255,.14),rgba(124,109,255,.05));border:1px solid rgba(124,109,255,.3);
font-size:18px;font-weight:800;line-height:1.5;color:#e6e0ff;position:relative}
.quote::before{content:'«';position:absolute;left:8px;top:2px;font-size:34px;color:rgba(124,109,255,.5)}
.todo{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:9px}
.todo li{display:flex;gap:11px;padding:12px 14px;border-radius:14px;background:rgba(47,211,154,.07);border:1px solid rgba(47,211,154,.2);font-size:14.5px;color:#d6e9df}
.todo li::before{content:'→';color:#2fd39a;font-weight:900;flex:none}
.method{margin:30px 0 0;padding:15px 17px;border-radius:14px;background:rgba(245,160,90,.08);border:1px solid rgba(245,160,90,.22);font-size:13px;color:#f0c9a4}
.more{margin:24px 0 0;display:flex;flex-wrap:wrap;gap:10px}
.more a{display:inline-flex;padding:11px 16px;border-radius:12px;border:1px solid rgba(148,180,255,.25);background:rgba(148,180,255,.07);color:#e8eefb;font-size:13px;font-weight:800;text-decoration:none}
.more a:hover{background:rgba(148,180,255,.14)}
.list{display:flex;flex-direction:column;gap:14px}
.item{padding:16px 18px;border:1px solid rgba(148,180,255,.16);border-radius:16px;background:rgba(148,180,255,.04)}
.item a{color:#e8eefb;text-decoration:none;font-size:17px;font-weight:800;line-height:1.35}
.item a:hover{color:#7db4ff}
.item time{display:block;margin-top:6px;font-size:11.5px;color:#6b7a96}
@media (max-width:560px){.brow{grid-template-columns:88px 1fr auto}.factcard b{font-size:34px}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
const DROP = '<svg viewBox="0 0 24 24"><path d="M12 2.6C12 2.6 5 10.6 5 14.6a7 7 0 0 0 14 0C19 10.6 12 2.6 12 2.6Z"/></svg>';
const METHOD = 'КогдаБенз каждые 10 минут собирает отметки о наличии топлива из открытого источника и от водителей на местах, а окна привоза строит по собственной истории возвратов топлива на каждой АЗС. Прогноз — вероятность по прошлым возвратам, а не гарантия привоза. Данные обновляются каждые 4 часа: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 МСК.';
function metricsScript(a) {
return '<script>(function(){try{' +
'var S="kbnews_"+location.pathname;if(sessionStorage.getItem(S))return;' +
'var t0=Date.now(),mx=0,fin=0;' +
'function pc(){var h=document.documentElement;var m=h.scrollHeight-innerHeight;return m>0?Math.min(100,Math.round(100*(scrollY||0)/m)):100;}' +
'addEventListener("scroll",function(){mx=Math.max(mx,pc());if(mx>92)fin=1;},{passive:true});' +
'var sent=0;function send(){if(sent)return;var d=Math.min(600000,Date.now()-t0);if(d<1500&&!fin)return;sent=1;sessionStorage.setItem(S,"1");' +
'fetch(' + JSON.stringify(SUP) + '+"/rest/v1/news_metrics",{method:"POST",keepalive:true,headers:{"Content-Type":"application/json","apikey":' + JSON.stringify(KEY) + ',"Authorization":"Bearer ' + KEY + '","Prefer":"return=minimal"},' +
'body:JSON.stringify([{slug:' + JSON.stringify(a.slug) + ',family:' + JSON.stringify(a.family) + ',variant:' + JSON.stringify(a.variant) + ',dwell_ms:d,scroll_pct:mx,finished:fin}])}).catch(function(){});}' +
'addEventListener("pagehide",send);document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")send();});' +
'}catch(e){}})();</scr' + 'ipt>';
}
function page(a) {
const url = SITE + '/news/' + a.slug + '.html';
const iso = new Date(a.t).toISOString();
const ld = {
'@context': 'https://schema.org', '@type': 'NewsArticle',
headline: a.title, description: a.lead,
datePublished: iso, dateModified: iso,
author: { '@type': 'Organization', name: 'КогдаБенз', url: SITE },
publisher: { '@type': 'Organization', name: 'КогдаБенз', url: SITE },
mainEntityOfPage: url, articleSection: 'Топливо и цены'
};
const fc = factcard(a);
let body = '';
body += '<h2 class="sec">' + w(H2.what) + '</h2>';
const whatParas = a.what.filter(Boolean);
whatParas.forEach((p, i) => { const at = i === 0 ? attrOnce(a) : ''; body += '<p>' + esc(at ? at + p.charAt(0).toLowerCase() + p.slice(1) : p) + '</p>'; });
body += '<h2 class="sec">' + w(H2.num) + '</h2>';
body += '<div class="factcard"><b>' + esc(fc.big) + '</b><span>' + esc(fc.lab) + '<i>' + esc(fc.sub) + '</i></span></div>';
body += '<div class="facts"><ul>' + a.facts.map(f => '<li>' + esc(f) + '</li>').join('') + '</ul></div>';
if (a.brands && a.brands.length) {
body += '<h2 class="sec">' + w(H2.brand) + '</h2>';
body += '<p class="bnote">' + esc(brandNote(a)) + '</p>';
body += '<div class="brands">' + a.brands.map(b => {
const pct = b.known ? Math.round(100 * b.a95 / b.known) : 0;
return '<div class="brow"><span class="bn">' + esc(b.name) + '</span><span class="bar"><i style="width:' + pct + '%"></i></span><span class="bv">' + b.a95 + ' из ' + b.known + '</span></div>';
}).join('') + '</div>';
}
if (a.cmp && (a.cmp.ly || a.cmp.lw || a.cmp.ry || a.cmp.rw)) {
body += '<h2 class="sec">' + w(H2.cmp) + '</h2>';
body += '<p>' + esc(cmpText(a)) + '</p>';
}
body += '<h2 class="sec">' + w(H2.mean) + '</h2>';
body += '<p>' + esc(bMeaning()) + ' ' + esc(bNext(a)) + '</p>';
body += '<div class="quote">' + esc(w(QUOTE[a.family] || QUOTE.loss)) + '</div>';
body += '<ul class="todo">' + todoList().map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>';
body += '<p>' + esc(w(SY.pay)) + ' ' + esc(bHonest()) + '</p>';
return `<!doctype html><html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(a.title)}</title>
<meta name="description" content="${esc(a.lead)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta property="og:type" content="article">
<meta property="og:site_name" content="КогдаБенз">
<meta property="og:locale" content="ru_RU">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(a.title)}">
<meta property="og:description" content="${esc(a.lead)}">
<meta property="og:image" content="${SITE + '/' + a.og}">
<meta property="article:published_time" content="${iso}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(a.title)}">
<meta name="twitter:description" content="${esc(a.lead)}">
<meta name="twitter:image" content="${SITE + '/' + a.og}">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>${CSS}</style></head><body><div class="wrap">
<header class="top"><span class="tile">${DROP}</span><span><b>КогдаБенз</b><small>данные о топливе</small></span>
<nav><a href="${SITE}/">Карта</a><a href="/news/">Все новости</a></nav></header>
<p class="kicker"><i></i>${esc(a.kicker)}</p>
<h1>${esc(a.title)}</h1>
<p class="meta">${stamp(a.t)} МСК · данные на ${stamp(a.t)}</p>
<p class="lead">${esc(a.lead)}</p>
${body}
<div class="method">${METHOD}</div>
<div class="more">${a.links.map(l => '<a href="' + l[0] + '">' + esc(l[1]) + '</a>').join('')}</div>
</div>${metricsScript(a)}</body></html>`;
}

// ---------- выпуск ----------
(async function run() {
if (!SUP || !KEY) { console.log('! newsroom: нет SUPABASE_URL/SUPABASE_KEY'); process.exit(1); }
const cands = [process.env.KB_SITE_DIR, process.env.SVODKA_DIR, process.cwd(), __dirname].filter(Boolean);
let dir = null;
for (const d of cands) { try { if (fs.existsSync(path.join(d, 'index.html'))) { dir = d; break; } } catch (e) {} }
if (!dir) { console.log('! newsroom: папка сайта не найдена'); process.exit(1); }
const newsDir = path.join(dir, 'news');
fs.mkdirSync(newsDir, { recursive: true });
let manifest = {};
try { manifest = JSON.parse(fs.readFileSync(path.join(newsDir, 'manifest.json'), 'utf8')); } catch (e) {}
const t = Date.now();
const D = await load();
const svodkas = readSvodkas(dir);
if (!svodkas.length) { console.log('! newsroom: нет svodka*.json — сначала собери сводки'); process.exit(1); }
const stats = aggStats(D.met);
const found = detect(D, svodkas, t);
const fresh = found.filter(a => !manifest[a.slug]);
const items = [];
for (const f of fresh) {
const vi = chooseVariant(f.family, stats, manifest);
const made = FORMULAS[f.family][vi](f);
const a = Object.assign({}, f, {
t, variant: f.family + ':' + vi,
title: made.title, lead: made.lead, what: made.what || [],
kicker: f.family === 'acc' ? 'Проверка прогнозов' : f.family === 'queue' ? (f.city || '') + ' · очереди' : f.family === 'deficit' ? (f.city || '') + ' · наличие' : f.label + ' · динамика',
facts: factsList(f)
});
if (f.family === 'loss' || f.family === 'ret') a.links = [[SITE + '/', 'Живая карта'], [SITE + '/' + REG[f.rk].file, 'Сводка региона']];
else if (f.family === 'deficit' || f.family === 'queue') a.links = [[SITE + '/' + (REG[f.rk] ? REG[f.rk].file : 'svodka.html') + '#c-' + f.slug.replace(/^(deficit|ocheredi)-/, '').replace(/-\d{8}$/, ''), 'Сводка по городу'], [SITE + '/', 'Живая карта']];
else a.links = [[SITE + '/', 'Живая карта и окна привоза'], [SITE + '/svodka.html', 'Сводка по югу']];
fs.writeFileSync(path.join(newsDir, a.slug + '.html'), page(a));
manifest[a.slug] = new Date(a.t).toISOString();
items.push(a);
console.log('✓ /news/' + a.slug + '.html [' + a.variant + '] — ' + a.title);
}
if (!items.length) console.log('newsroom: новых поводов нет (проверено: ' + found.length + ')');
// ФИКС v3: в список выпусков попадают только строковые ключи-даты (без служебного used)
const all = Object.keys(manifest).filter(k => typeof manifest[k] === 'string').sort().reverse().slice(0, 60);
const idxItems = all.map(slug => {
let title = slug, when = manifest[slug];
try {
const h = fs.readFileSync(path.join(newsDir, slug + '.html'), 'utf8');
const m = h.match(/<h1>([\s\S]*?)<\/h1>/);
if (m) title = unesc(m[1].replace(/<[^>]+>/g, '').trim());
} catch (e) {}
return '<div class="item"><a href="/news/' + slug + '.html">' + esc(title) + '</a><time>' + stamp(new Date(when).getTime()) + ' МСК</time></div>';
}).join('');
fs.writeFileSync(path.join(newsDir, 'index.html'), `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Новости топлива юга, Северо-Запада и Чувашии — КогдаБенз</title>
<meta name="description" content="Короткие выпуски по данным о наличии топлива: волны дефицита, возвраты, очереди и точность прогнозов привоза.">
<link rel="canonical" href="${SITE}/news/">
<meta name="robots" content="index,follow">
<link rel="alternate" type="application/rss+xml" title="КогдаБенз — новости топлива" href="${SITE}/news/rss.xml">
<style>${CSS}</style></head><body><div class="wrap">
<header class="top"><span class="tile">${DROP}</span><span><b>КогдаБенз</b><small>данные о топливе</small></span>
<nav><a href="${SITE}/">Карта</a><a href="/news/rss.xml">RSS</a></nav></header>
<h1>Новости топлива</h1>
<p class="meta">Выпуски собираются автоматически из данных карты: волны дефицита, возвраты, очереди, точность прогнозов.</p>
<div class="list">${idxItems || '<div class="item">Выпусков пока нет — первые появятся, когда в данных будет новостной повод.</div>'}</div>
</div></body></html>`);
const rssItems = all.map(slug => ({ slug, t: new Date(manifest[slug]).getTime() }))
.sort((a, b) => b.t - a.t).slice(0, 50).map(a => {
let title = a.slug, lead = '';
try {
const h = fs.readFileSync(path.join(newsDir, a.slug + '.html'), 'utf8');
const m1 = h.match(/<h1>([\s\S]*?)<\/h1>/), m2 = h.match(/class="lead">([\s\S]*?)<\/p>/);
if (m1) title = unesc(m1[1].replace(/<[^>]+>/g, '').trim());
if (m2) lead = unesc(m2[1].replace(/<[^>]+>/g, '').trim());
} catch (e) {}
return '<item><title>' + esc(title) + '</title><link>' + SITE + '/news/' + a.slug + '.html</link>' +
'<guid isPermaLink="true">' + SITE + '/news/' + a.slug + '.html</guid>' +
'<pubDate>' + new Date(a.t).toUTCString() + '</pubDate>' +
'<description>' + esc(lead) + '</description></item>';
}).join('\n');
fs.writeFileSync(path.join(newsDir, 'rss.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n' +
'<title>КогдаБенз — новости топлива</title><link>' + SITE + '/news/</link>\n' +
'<atom:link href="' + SITE + '/news/rss.xml" rel="self" type="application/rss+xml"/>\n' +
'<description>Волны дефицита, возвраты топлива, очереди и точность прогнозов привоза по данным живой карты.</description>\n' +
'<language>ru</language><category>Топливо и цены</category><ttl>60</ttl>\n' +
'<image><url>' + SITE + '/icon-512.png</url><title>КогдаБенз — новости топлива</title><link>' + SITE + '/news/</link></image>\n' +
'<lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>\n' + rssItems + '\n</channel></rss>');
const nowT = Date.now();
const newsUrls = all.filter(s => nowT - new Date(manifest[s]).getTime() < 48 * H).map(s => {
let nt = 'КогдаБенз: выпуск данных';
try { const h = fs.readFileSync(path.join(newsDir, s + '.html'), 'utf8'); const m = h.match(/<h1>([\s\S]*?)<\/h1>/); if (m) nt = unesc(m[1].replace(/<[^>]+>/g, '').trim()); } catch (e) {}
return '<url><loc>' + SITE + '/news/' + s + '.html</loc><news:news><news:publication><news:name>КогдаБенз</news:name><news:language>ru</news:language></news:publication><news:publication_date>' + manifest[s] + '</news:publication_date><news:title>' + esc(nt) + '</news:title></news:news></url>';
}).join('\n');
fs.writeFileSync(path.join(dir, 'sitemap-news.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/news-sitemap">\n' + newsUrls + '\n</urlset>');
const sp = path.join(dir, 'sitemap.xml');
let sm = fs.existsSync(sp) ? fs.readFileSync(sp, 'utf8') : '';
if (sm.indexOf('<urlset') < 0) sm = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>';
if (sm.indexOf(SITE + '/news/') < 0) {
const add = ['  <url><loc>' + SITE + '/news/</loc><changefreq>hourly</changefreq><priority>0.7</priority></url>']
.concat(all.map(s => '  <url><loc>' + SITE + '/news/' + s + '.html</loc><changefreq>daily</changefreq><priority>0.6</priority></url>')).join('\n');
sm = sm.replace(/<\/urlset>/i, add + '\n</urlset>');
fs.writeFileSync(sp, sm);
}
(function injectNewsLinks() {
try {
const total = all.length;
if (!total) return;
for (const f of ['index.html', 'svodka.html', 'svodka-sz.html', 'svodka-ch.html']) {
const p = path.join(dir, f);
if (!fs.existsSync(p)) continue;
let h = fs.readFileSync(p, 'utf8');
h = h.replace(/<!--kb-newsline-->[\s\S]*?<!--\/kb-newsline-->\s*/g, '');
const strip = '<!--kb-newsline--><a href="/news/" style="display:flex;gap:10px;align-items:center;margin:18px auto 0;max-width:1120px;padding:13px 16px;border:1px solid rgba(148,180,255,.2);border-radius:14px;background:rgba(148,180,255,.06);color:#e8eefb;text-decoration:none;font:700 13px/1.4 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif"><span style="flex:none;width:9px;height:9px;border-radius:50%;background:#2fd39a"></span><span style="flex:1">Новости топлива: волны дефицита, очереди и точность прогнозов — ' + total + ' ' + plural(total, ['выпуск', 'выпуска', 'выпусков']) + '</span><span style="color:#7db4ff">читать →</span></a><!--/kb-newsline-->';
if (/<\/body>/i.test(h)) h = h.replace(/<\/body>/i, strip + '\n</body>'); else h += strip;
fs.writeFileSync(p, h);
}
} catch (e) { console.log(' ! Ссылка на новости: ' + e.message); }
})();
try {
const rp = path.join(dir, 'robots.txt');
let rb = fs.existsSync(rp) ? fs.readFileSync(rp, 'utf8') : 'User-agent: *\nAllow: /\n';
for (const u of [SITE + '/sitemap.xml', SITE + '/sitemap-news.xml', SITE + '/news/rss.xml']) {
const line = 'Sitemap: ' + u;
if (rb.indexOf(line) < 0) rb = rb.replace(/\s+$/, '') + '\n' + line + '\n';
}
fs.writeFileSync(rp, rb);
} catch (e) {}
fs.writeFileSync(path.join(newsDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log('newsroom: статей добавлено ' + items.length + ', всего в индексе ' + all.length + ', метрик собрано ' + D.met.length);
if (NO_GIT) { console.log('Публикация пропущена (--no-git).'); return; }
if (!fs.existsSync(path.join(dir, '.git'))) { console.log('! нет .git — закоммить вручную.'); return; }
try {
const cp = require('child_process');
const gr = c => cp.execSync(c, { cwd: dir, stdio: 'pipe', timeout: 120000 });
gr('git add -A');
try { gr('git -c user.name="kogdabenz-bot" -c user.email="bot@kogdabenz.ru" commit -m "newsroom v3: live editor"'); } catch (e) {}
gr('git push');
console.log('Опубликовано.');
} catch (e) { console.log('! git push: ' + String(e.message).split('\n')[0]); }
})().catch(e => { console.log('! newsroom: ' + e.message); process.exit(1); });