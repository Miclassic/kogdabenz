'use strict';
// ============================================================
// КогдаБенз · НЬЮСРУМ v2 — «редактор с нейронами»
// 1) Живой язык: пулы синонимов, 30 формул заголовков и лидов,
//    перемешивание абзацев, открытая петля и payoff в конце.
// 2) Защита от кривых формулировок: «только на 0 из…» больше
//    не появится никогда (нулевые и полные случаи пишутся словами).
// 3) Антиповторы: недавние формулы каждого жанра не повторяются.
// 4) Обучение: страница меряет время чтения, скролл и «дочитал»,
//    шлёт в news_metrics; bandit (75% лучший / 25% разведка)
//    выбирает формулы, которые дочитывают чаще.
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
const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function p2(n) { return String(n).padStart(2, '0'); }
function msk(t) { return new Date(t + 3 * H); }
function stamp(t) { const d = msk(t); return p2(d.getUTCDate()) + '.' + p2(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() + ', ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()); }
function dateRu(t) { const d = msk(t); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; }
function plural(n, f) { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return f[2]; if (b > 1 && b < 5) return f[1]; if (b === 1) return f[0]; return f[2]; }
function w(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(a) { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = r[i]; r[i] = r[j]; r[j] = t; } return r; }
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// ---------- словари редактора ----------
const SY = {
day: ['За последние 24 часа', 'За минувшие сутки', 'За сутки с прошлого выпуска', 'За один день'],
lost: ['топливо пропало с', 'топливо исчезло с', 'отметки «нет топлива» пришли с', 'колонки погасли на'],
ret: ['топливо вернулось на', 'топливо снова появилось на', 'колонки ожили на', 'заправки снова показывают наличие на'],
wave: ['Это похоже на волну: топливо уходит группами, а не по одной колонке.', 'Одиночные сбои так не выглядят — движение синхронное, сразу по нескольким сетям.', 'Так бывает, когда поставка не приходит в срок сразу нескольким брендам.'],
waveBack: ['Возвраты редко бывают одиночными: когда машина приходит на сеть, колонки оживают сразу на нескольких адресах.', 'Волна возврата обычно идёт вслед за привозом на базы.', 'Ожившие колонки — след одной поставки, а не двадцати случайных совпадений.'],
mean: ['Что это значит для водителя', 'Что это значит на практике', 'Как это читать перед выездом', 'Что из этого следует для поездки'],
meanTail: ['проверять наличие стоит даже на «своей» заправке.', 'выезд наугад сейчас может закончиться пустой колонкой.', 'короткая проверка карты экономит один круг по городу.', 'планировать заправку лучше по окнам привоза, а не по памяти.'],
honest: ['Мы не дорисовываем картину: где данных нет, там честно пишем «нет данных».', 'Карта показывает только подтверждённое: источником, водителями или отметкой с места.', 'Обещаний в выпуске нет — только факты с временем и происхождением.'],
loop: ['Ниже — цифра, которая объясняет картину целиком.', 'Главная деталь выпуска — в конце, и она меняет вывод.', 'Дочитайте до последнего абзаца: там то, что обычно пропускают.'],
pay: ['И главное: это не приговор на неделю, а снимок часа — картина переписывается каждые 4 часа.', 'И последнее: одна отметка водителя с места перевешивает устаревший снимок источника — карта живая.', 'И напоследок: точность таких выпусков проверяется ночью, а не «на глаз» — ошибки публикуются открыто.']
};
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
function paras(c, blocks) {
const head = blocks[0];
const rest = shuffle(blocks.slice(1)).filter(Boolean);
const out = [head].concat(rest);
out.splice(1, 0, w(SY.loop));
out.push(w(SY.pay));
return out.filter(Boolean);
}
const TAILS = ['— и это не последняя цифра дня', '— одна деталь меняет привычную картину', '— водители уже перестроили маршруты', '— объясняем, что будет дальше', '— и куда делся бензин'];
function tail() { return Math.random() < 0.35 ? ' ' + w(TAILS) : ''; }

// ---------- формулы жанров (варианты для обучения) ----------
const FORMULAS = {
loss: [
c => ({ title: cap(c.where) + ' за сутки топливо пропало с ' + c.lost + ' ' + plural(c.lost, ['АЗС', 'АЗС', 'АЗС']) + tail(),
lead: w(SY.day) + ' отметки «топлива нет» появились на ' + c.lost + ' ' + plural(c.lost, ['заправке', 'заправках', 'заправок']) + ' (' + c.where + '). ' + w(SY.wave),
paras: paras(c, [w(SY.day) + ' карта зафиксировала ' + c.lost + ' ' + plural(c.lost, ['потерю', 'потери', 'потерь']) + ' топлива (' + c.where + ').', bExamples(c.names), bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: 'Куда делся бензин? ' + cap(c.where) + ' теряет ' + c.lost + ' ' + plural(c.lost, ['АЗС', 'АЗС', 'АЗС']) + ' за день',
lead: 'Вопрос дня у водителей простой: куда делся бензин. За сутки ' + w(['карта насчитала', 'источник и водители принесли', 'в сводку попало']) + ' ' + c.lost + ' ' + plural(c.lost, ['заправку', 'заправки', 'заправок']) + ' с отметкой «нет» (' + c.where + ').',
paras: paras(c, [w(SY.wave), bExamples(c.names), bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: c.lost + ' пустых колонок за сутки: хроника волны ' + c.wherePrep,
lead: 'Это не сбой одной сети и не случайность: за сутки ' + c.lost + ' ' + plural(c.lost, ['АЗС', 'АЗС', 'АЗС']) + ' (' + c.where + ') показали отсутствие топлива почти одновременно.',
paras: paras(c, [w(SY.wave), bExamples(c.names), bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: 'Утро, а топлива нет: ' + c.lost + ' ' + plural(c.lost, ['АЗС', 'АЗС', 'АЗС']) + ' ' + c.where + ' за сутки',
lead: w(SY.day) + ' список «нет топлива» пополнился на ' + c.lost + ' ' + plural(c.lost, ['позицию', 'позиции', 'позиций']) + ' (' + c.where + '). Для сравнения: возвратов за то же время — ' + c.ret + '.',
paras: paras(c, [w(SY.wave), bExamples(c.names), bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: 'Почему у колонок снова пусто? ' + c.lost + ' ' + plural(c.lost, ['факт', 'факта', 'фактов']) + ' за сутки ' + c.wherePrep,
lead: 'Короткий ответ: волна. Длинный — в цифрах: ' + c.lost + ' ' + plural(c.lost, ['АЗС', 'АЗС', 'АЗС']) + ' за сутки показали «нет» (' + c.where + '), и это синхронное движение, а не двадцать случайностей.',
paras: paras(c, [w(SY.wave), bExamples(c.names), bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: 'Минус ' + c.lost + ' ' + plural(c.lost, ['заправка', 'заправки', 'заправок']) + ' с топливом за один день (' + c.label + ')',
lead: 'Сводка за сутки читается как сводка с фронта: ' + c.lost + ' ' + plural(c.lost, ['АЗС', 'АЗС', 'АЗС']) + ' (' + c.where + ') потеряли топливо, вернули за то же время — ' + c.ret + '.',
paras: paras(c, [w(SY.wave), bExamples(c.names), bMeaning(), bNext(c), bHonest()]) })
],
ret: [
c => ({ title: cap(c.where) + ' за сутки топливо вернулось на ' + c.ret + ' ' + plural(c.ret, ['АЗС', 'АЗС', 'АЗС']) + tail(),
lead: w(SY.day) + ' ' + c.ret + ' ' + plural(c.ret, ['заправка снова показала', 'заправки снова показали', 'заправок снова показали']) + ' наличие топлива (' + c.where + '). ' + w(SY.waveBack),
paras: paras(c, ['Возвратов за сутки: ' + c.ret + ' (' + c.where + ').', bExamples(c.names), bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: 'Бензин возвращается: ' + c.ret + ' ' + plural(c.ret, ['АЗС', 'АЗС', 'АЗС']) + ' ' + c.where + ' ожили за сутки',
lead: 'Хорошая новость дня: колонки оживают. За сутки ' + c.ret + ' ' + plural(c.ret, ['АЗС', 'АЗС', 'АЗС']) + ' (' + c.where + ') снова показывают наличие.',
paras: paras(c, [w(SY.waveBack), bExamples(c.names), bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: 'Плюс ' + c.ret + ' ' + plural(c.ret, ['заправка', 'заправки', 'заправок']) + ' с топливом за один день (' + c.label + ')',
lead: 'Сводка за сутки со знаком плюс: ' + c.ret + ' ' + plural(c.ret, ['АЗС', 'АЗС', 'АЗС']) + ' (' + c.where + ') вернули топливо в продажу.',
paras: paras(c, [w(SY.waveBack), bExamples(c.names), bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: 'Куда смотреть, если вчера было пусто: ' + c.ret + ' ' + plural(c.ret, ['возврат', 'возврата', 'возвратов']) + ' за сутки ' + c.wherePrep,
lead: 'Вчерашние «пустые» адреса оживают: за сутки ' + c.ret + ' ' + plural(c.ret, ['АЗС', 'АЗС', 'АЗС']) + ' (' + c.where + ') снова с топливом.',
paras: paras(c, [w(SY.waveBack), bExamples(c.names), bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: 'Привоз пришёл? ' + c.ret + ' ' + plural(c.ret, ['АЗС', 'АЗС', 'АЗС']) + ' ' + c.where + ' за сутки показали топливо',
lead: 'Похоже на след одной поставки: за сутки ' + c.ret + ' ' + plural(c.ret, ['АЗС', 'АЗС', 'АЗС']) + ' (' + c.where + ') вернули наличие почти одновременно.',
paras: paras(c, [w(SY.waveBack), bExamples(c.names), bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: 'Оттепель у колонок: ' + c.ret + ' ' + plural(c.ret, ['возврат', 'возврата', 'возвратов']) + ' топлива за сутки (' + c.label + ')',
lead: w(SY.day) + ' карта зафиксировала ' + c.ret + ' ' + plural(c.ret, ['возврат', 'возврата', 'возвратов']) + ' топлива (' + c.where + ') — при ' + c.lost + ' ' + plural(c.lost, ['потере', 'потерях', 'потерях']) + ' за то же время.',
paras: paras(c, [w(SY.waveBack), bExamples(c.names), bMeaning(), bNext(c), bHonest()]) })
],
deficit: [
c => ({ title: c.city + ': ' + availPhrase(c) + tail(),
lead: 'В городе ' + c.city + ' ' + availPhrase(c) + '. Остальные либо показывают «нет», либо молчат — и молчание сейчас хуже «нет».',
paras: paras(c, ['Картина на ' + c.stamp + ': ' + availPhrase(c) + '.', 'АИ-92 есть на ' + c.a92 + ', дизель — на ' + c.adt + ' из тех же ' + c.known + '.', bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: 'Где заправиться в городе ' + c.city + '? Ответ короткий: ' + c.a95 + ' ' + plural(c.a95, ['адрес', 'адреса', 'адресов']) + ' из ' + c.known,
lead: 'Если искать АИ-95 в городе ' + c.city + ' прямо сейчас, рабочих адресов ' + c.a95 + ' из ' + c.known + ' станций с данными. Это не слух и не оценка — подтверждённые отметки.',
paras: paras(c, [availPhrase(c) + ' — снимок на ' + c.stamp + '.', 'Очередей в городе отмечено: ' + c.q + '. Окон привоза: ' + c.wins + '.', bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: c.city + ' на топлидном голодании: ' + c.a95 + ' из ' + c.known + ' — и ни одной лишней',
lead: 'Цифра дня по городу ' + c.city + ': ' + c.a95 + ' ' + plural(c.a95, ['АЗС', 'АЗС', 'АЗС']) + ' с подтверждённым АИ-95 из ' + c.known + '. Всё, что сверх этого, — догадки, а мы их не публикуем.',
paras: paras(c, [availPhrase(c) + '.', 'Для сравнения: АИ-92 держат ' + c.a92 + ' ' + plural(c.a92, ['АЗС', 'АЗС', 'АЗС']) + ', дизель — ' + c.adt + '.', bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: 'Стоит ли ехать наугад в городе ' + c.city + '? Цифры говорят нет',
lead: 'В городе ' + c.city + ' ' + availPhrase(c) + '. Езда наугад при такой картине — это лотерея с очередями в придачу.',
paras: paras(c, [availPhrase(c) + ' на ' + c.stamp + '.', 'Окон привоза по городу: ' + c.wins + ' — это вероятное время оживления колонок.', bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: c.known + ' ' + plural(c.known, ['заправка', 'заправки', 'заправок']) + ', ' + c.a95 + ' с топливом: честный срез города ' + c.city,
lead: 'Без прикрас: в городе ' + c.city + ' из ' + c.known + ' станций с данными АИ-95 подтверждён на ' + c.a95 + '. Остальные — «нет» или тишина источника.',
paras: paras(c, [availPhrase(c) + '.', 'Очереди: ' + c.q + ' ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']) + '. Окна привоза: ' + c.wins + '.', bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: 'Что с бензином в городе ' + c.city + ' к ' + c.hhmm + '? Отвечаем цифрами',
lead: 'К ' + c.hhmm + ' в городе ' + c.city + ' ' + availPhrase(c) + '. Ниже — что это значит для поездки и когда ждать изменений.',
paras: paras(c, [availPhrase(c) + '.', 'АИ-92: ' + c.a92 + ' из ' + c.known + ', дизель: ' + c.adt + ' из ' + c.known + '.', bMeaning(), bNext(c), bHonest()]) })
],
queue: [
c => ({ title: c.city + ': очереди отмечены на ' + c.q + ' ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']) + tail(),
lead: 'Водители сообщают о высокой очереди на ' + c.q + ' ' + plural(c.q, ['заправке', 'заправках', 'заправках']) + ' города ' + c.city + '. Очередь — ранний признак того, что топливо в городе на исходе.',
paras: paras(c, ['Очередей в городе сейчас: ' + c.q + '.', 'Очереди появляются раньше, чем источник успевает снять отметки наличия.', bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: 'Хвосты у колонок: ' + c.q + ' ' + plural(c.q, ['очередь', 'очереди', 'очередей']) + ' в городе ' + c.city,
lead: 'В городе ' + c.city + ' водители отметили живые очереди на ' + c.q + ' ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']) + '. Там, где хвост, там и пустая колонка через час.',
paras: paras(c, ['Отметка об очереди живёт около часа и ставится одним тапом — поэтому карта очередей свежее сводки наличия.', 'АИ-95 в городе: ' + availPhrase(c) + '.', bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: 'Почему в городе ' + c.city + ' снова стоят в очереди',
lead: 'Причина проста и видна в цифрах: ' + availPhrase(c) + ', а очереди отмечены на ' + c.q + ' ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']) + '. Спрос идёт туда, где топливо ещё есть.',
paras: paras(c, ['Очереди — это спрос, сконцентрированный на немногих рабочих адресах.', 'Окон привоза по городу: ' + c.wins + '.', bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: c.q + ' ' + plural(c.q, ['очередь', 'очереди', 'очередей']) + ' за один вечер: что происходит в городе ' + c.city,
lead: 'Вечерний срез по городу ' + c.city + ': высокие очереди на ' + c.q + ' ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']) + '. Это не впечатление, а отметки водителей с временем.',
paras: paras(c, ['Очередь — самый быстрый сигнал дефицита: быстрее источника и быстрее сводки.', availPhrase(c) + '.', bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: 'Ехать или переждать? Очереди города ' + c.city + ' на ' + c.hhmm,
lead: 'На ' + c.hhmm + ' в городе ' + c.city + ' очереди отмечены на ' + c.q + ' ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']) + '. Решать вам, но вот контекст.',
paras: paras(c, [availPhrase(c) + '.', 'Окон привоза: ' + c.wins + ' — по ним видно, когда хвосты рассосутся сами.', bMeaning(), bNext(c), bHonest()]) }),
c => ({ title: 'Город ' + c.city + ' встал у колонок: ' + c.q + ' ' + plural(c.q, ['точка', 'точки', 'точек']) + ' с очередью',
lead: 'Карта очередей по городу ' + c.city + ' показала ' + c.q + ' ' + plural(c.q, ['АЗС', 'АЗС', 'АЗС']) + ' с высокой очередью. Обычно так выглядит день перед волной возвратов.',
paras: paras(c, ['Очереди отмечали водители, а не алгоритм: у каждой отметки есть устройство и время.', 'Окон привоза по городу: ' + c.wins + '.', bMeaning(), bNext(c), bHonest()]) })
],
acc: [
c => ({ title: c.hit + ' из ' + c.verified + ': как на самом деле сбывается прогноз привоза (' + c.rate + '%)',
lead: 'За 30 дней проверено ' + c.verified + ' ' + plural(c.verified, ['прогноз', 'прогноза', 'прогнозов']) + ' привоза: топливо вернулось в объявленное окно в ' + c.hit + ' ' + plural(c.hit, ['случае', 'случаях', 'случаях']) + ' (' + c.rate + '%). Цифра открытая, и мы объясняем, что за ней.',
paras: paras(c, ['Каждый прогноз проверяется задним числом: окно сравнивается с фактом, ошибка уходит в статистику.', 'Окно привоза специально широкое (4–6 часов): это честный интервал вероятности, а не обещание «ровно в 14:00».', c.rate < 30 ? 'Строгое попадание в окно — жёсткая планка: часть проверок пришлась на дни, когда поставщики срывали привозы целиком.' : 'Каждый следующий проверенный случай уточняет квантили модели — точность дообучается на фактах.', bHonest()]) }),
c => ({ title: 'Мы посчитали свою точность честно: ' + c.rate + '% попаданий в окно привоза',
lead: 'Никаких «до 90%»: за 30 дней строгое попадание в объявленное окно — ' + c.hit + ' из ' + c.verified + ' (' + c.rate + '%). Показываем, почему это не провал и не победа, а рабочий инструмент.',
paras: paras(c, ['Прогноз строится по квантилям 20–80% прошлых возвратов конкретной АЗС или её бренда.', 'Ширина окна — плата за честность: узкое окно давало бы красивые проценты и пустые колонки.', bMeaning(), bHonest()]) }),
c => ({ title: 'Сбылось или нет? ' + c.verified + ' ' + plural(c.verified, ['проверка', 'проверки', 'проверок']) + ' прогноза привоза за месяц',
lead: 'Ночная проверка сверяет вчерашние окна с фактом. Итог месяца: ' + c.hit + ' попаданий из ' + c.verified + ' (' + c.rate + '%). Медианная ошибка публикуется там же, без округлений в свою пользу.',
paras: paras(c, ['Проверка идёт каждую ночь автоматически: факт возврата сравнивается с окном.', 'Ошибки модели уходят в калибровку — следующие окна строятся уже с учётом этого месяца.', bMeaning(), bHonest()]) }),
c => ({ title: 'Почему прогнозу можно верить на ' + c.rate + '%, а не на все сто',
lead: 'Честный ответ: строгое попадание в окно за месяц — ' + c.hit + ' из ' + c.verified + ' (' + c.rate + '%). Прогноз и не обещает certainty: он сужает круг часов, в которые привоз вероятен.',
paras: paras(c, ['Окно привоза — это интервал вероятности, посчитанный по истории возвратов.', 'Альтернатива прогнозу — ехать наугад: у наугад точность ниже, а цена та же очередь.', bMeaning(), bHonest()]) }),
c => ({ title: 'Месяц проверок: ' + c.hit + ' совпадений из ' + c.verified + ' и что мы изменим в модели',
lead: 'Статистика месяца: ' + c.hit + ' из ' + c.verified + ' прогнозов попали в окно (' + c.rate + '%). Это не приговор модели, а её учебник: каждый промах уточняет квантили.',
paras: paras(c, ['Калибровка пересобирается по свежим проверкам — следующие выпуски строятся уже на этих ошибках.', 'Открытая публикация точности — осознанная: доверие дороже красивой цифры.', bMeaning(), bHonest()]) }),
c => ({ title: 'Точность без прикрас: ' + c.rate + '% попаданий в окно и почему это нормально',
lead: 'За 30 дней: ' + c.verified + ' ' + plural(c.verified, ['проверка', 'проверки', 'проверок']) + ', ' + c.hit + ' попаданий в строгое окно (' + c.rate + '%). Объясняем, что меряем и почему так жёстко.',
paras: paras(c, ['Меряем строгое попадание: факт возврата должен попасть внутрь объявленного интервала.', 'Мягкая метрика (факт в тот же день) выше, но мы публикуем строгую — она честнее.', bMeaning(), bHonest()]) })
]
};

// ---------- обучение (bandit) ----------
function variantScore(st) {
if (!st || !st.n) return 0;
const shrink = st.n / (st.n + 3);
const s = (st.fin * 0.5 + (st.scroll / 100) * 0.3 + Math.min(st.dwell, 120000) / 120000 * 0.2);
return s * shrink;
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
for (const i of avail) {
const s = variantScore(stats[family + ':' + i]);
if (s > bestS) { bestS = s; best = i; }
}
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
const since24 = new Date(Date.now() - 24 * H).toISOString();
const evs = await sbGet('events?event_type=in.(fuel_disappeared,fuel_restored)&detected_at=gte.' + since24 + '&select=station_id,event_type,fuel_type,detected_at&limit=3000');
const ver = await sbGet('predictions?is_verified=eq.true&verified_at=gte.' + new Date(Date.now() - 30 * 24 * H).toISOString() + '&select=result,verified_at&limit=1000');
let met = [];
try { met = await sbGet('news_metrics?select=family,variant,dwell_ms,scroll_pct,finished&limit=5000'); } catch (e) {}
return { stations, evs, ver, met };
}
function readSvodkas(dir) {
const out = [];
for (const f of ['svodka.json', 'svodka-sz.json', 'svodka-ch.json']) {
try {
const p = path.join(dir, f);
if (!fs.existsSync(p)) continue;
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
out.push({ file: f, region: j.region, totals: j.totals, cities: j.cities || [] });
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

// ---------- детектор поводов ----------
function detect(D, svodkas, t) {
const out = [];
const stById = {};
for (const s of D.stations) stById[s.id] = s;
const byReg = { lost: {}, ret: {}, lostSt: {}, retSt: {} };
for (const e of D.evs) {
const s = stById[e.station_id]; if (!s) continue;
const r = s.region || 'south';
if (e.event_type === 'fuel_disappeared') { byReg.lost[r] = (byReg.lost[r] || 0) + 1; (byReg.lostSt[r] = byReg.lostSt[r] || {})[e.station_id] = 1; }
else { byReg.ret[r] = (byReg.ret[r] || 0) + 1; (byReg.retSt[r] = byReg.retSt[r] || {})[e.station_id] = 1; }
}
const names = (map, n) => Object.keys(map || {}).slice(0, n).map(id => stById[id]).filter(Boolean).map(s => '«' + (s.name || 'АЗС') + '»' + (s.address ? ', ' + s.address : ''));
const d = msk(t), day = '' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate());
for (const r of Object.keys(REG)) {
const lost = byReg.lost[r] || 0, ret = byReg.ret[r] || 0;
const thL = r === 'south' ? TH.lossSouth : TH.lossOther, thR = r === 'south' ? TH.retSouth : TH.retOther;
if (lost >= thL) out.push({ family: 'loss', slug: 'volna-uhod-' + r + '-' + day, og: 'og-' + r + '.png',
ctx: { lost, ret, where: REG[r].where, wherePrep: REG[r].prep, label: REG[r].label, names: names(byReg.lostSt[r], 4), wins: 0 } });
if (ret >= thR) out.push({ family: 'ret', slug: 'volna-vozvrat-' + r + '-' + day, og: 'og-' + r + '.png',
ctx: { lost, ret, where: REG[r].where, wherePrep: REG[r].prep, label: REG[r].label, names: names(byReg.retSt[r], 4), wins: 0 } });
}
for (const sv of svodkas) {
for (const c of sv.cities) {
if (!c.known || c.known < 8) continue;
if (c.level === 'r') out.push({ family: 'deficit', slug: 'deficit-' + c.key + '-' + day, og: 'og-' + c.key + '.png',
ctx: { city: c.name, a95: c.a95, a92: c.a92, adt: c.adt, known: c.known, q: c.q, wins: c.wins, stamp: stamp(t), hhmm: stamp(t).split(', ')[1] } });
if (c.q >= TH.queueCity) out.push({ family: 'queue', slug: 'ocheredi-' + c.key + '-' + day, og: 'og-' + c.key + '.png',
ctx: { city: c.name, q: c.q, a95: c.a95, known: c.known, wins: c.wins, hhmm: stamp(t).split(', ')[1] } });
}
}
const verified = D.ver.filter(v => v.verified_at);
if (verified.length >= TH.accMin) {
const hit = verified.filter(v => v.result === 'SUCCESS').length;
out.push({ family: 'acc', slug: 'tochnost-' + day, og: 'og-south.png',
ctx: { verified: verified.length, hit, rate: Math.round(100 * hit / verified.length) } });
}
return out;
}

// ---------- страница ----------
const CSS = `
*{box-sizing:border-box}html{background:#0a1024;scrollbar-color:#3f74d6 rgba(148,180,255,.1)}
body{margin:0;background:linear-gradient(180deg,#0d1526,#0a1024 60%,#080d1c);color:#e8eefb;
font:17px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:#7db4ff}::selection{background:#2465ee;color:#fff}
.wrap{max-width:700px;margin:0 auto;padding:22px 18px 60px}
.top{display:flex;align-items:center;gap:10px;padding:14px 0 18px;border-bottom:1px solid rgba(148,180,255,.16);margin-bottom:26px}
.top .tile{width:34px;height:34px;border-radius:11px;background:linear-gradient(140deg,#4b93ff,#1746c8);display:grid;place-items:center;flex:none}
.top .tile svg{width:17px;height:17px;fill:#fff}
.top b{font-size:15px;letter-spacing:-.2px}.top small{display:block;font-size:9.5px;font-weight:800;letter-spacing:.14em;color:#6b7a96;text-transform:uppercase}
.top nav{margin-left:auto;display:flex;gap:14px;font-size:12.5px;font-weight:700}
.kicker{display:inline-block;font-size:10.5px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#2fd39a;margin:0 0 10px}
h1{margin:0 0 12px;font-size:clamp(24px,5.6vw,36px);line-height:1.15;font-weight:900;letter-spacing:-.8px}
.meta{font-size:12.5px;color:#93a0b8;margin:0 0 20px}
.lead{font-size:18px;font-weight:700;line-height:1.55;color:#f2f6ff;margin:0 0 18px}
p{margin:0 0 15px}
.facts{margin:22px 0;padding:16px 18px;border:1px solid rgba(148,180,255,.18);border-radius:16px;background:rgba(148,180,255,.05)}
.facts b{display:block;font-size:11px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#93a0b8;margin-bottom:9px}
.facts ul{margin:0;padding-left:18px}.facts li{margin:5px 0;font-size:15px}
.method{margin:26px 0 0;padding:14px 16px;border-radius:14px;background:rgba(245,160,90,.08);border:1px solid rgba(245,160,90,.22);font-size:13px;color:#f0c9a4}
.more{margin:26px 0 0;display:flex;flex-wrap:wrap;gap:10px}
.more a{display:inline-flex;padding:10px 15px;border-radius:12px;border:1px solid rgba(148,180,255,.25);background:rgba(148,180,255,.07);color:#e8eefb;font-size:13px;font-weight:800;text-decoration:none}
.more a:hover{background:rgba(148,180,255,.14)}
.list{display:flex;flex-direction:column;gap:14px}
.item{padding:16px 18px;border:1px solid rgba(148,180,255,.16);border-radius:16px;background:rgba(148,180,255,.04)}
.item a{color:#e8eefb;text-decoration:none;font-size:17px;font-weight:800;line-height:1.35}
.item a:hover{color:#7db4ff}
.item time{display:block;margin-top:6px;font-size:11.5px;color:#6b7a96}
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
<p class="kicker">${esc(a.kicker)}</p>
<h1>${esc(a.title)}</h1>
<p class="meta">${stamp(a.t)} МСК · КогдаБенз · данные на ${stamp(a.t)}</p>
<p class="lead">${esc(a.lead)}</p>
${a.paras.map(p => '<p>' + esc(p) + '</p>').join('')}
${a.facts.length ? '<div class="facts"><b>Цифры выпуска</b><ul>' + a.facts.map(f => '<li>' + esc(f) + '</li>').join('') + '</ul></div>' : ''}
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
const made = FORMULAS[f.family][vi](f.ctx);
const a = Object.assign({}, f, { t, family: f.family, variant: f.family + ':' + vi,
title: made.title, lead: made.lead, paras: made.paras, kicker: made.kicker || (REG[f.family] ? REG[f.family].label : 'Данные'),
facts: made.facts || [], links: made.links || [[SITE + '/', 'Живая карта']] });
if (!a.links || !a.links.length) a.links = [[SITE + '/', 'Живая карта']];
if (f.family === 'loss' || f.family === 'ret') a.links = [[SITE + '/', 'Живая карта'], [SITE + '/' + REG[f.ctx.where === REG.south.where ? 'south' : f.ctx.where === REG.northwest.where ? 'northwest' : 'chuvashia'].file, 'Сводка региона']];
if (f.family === 'deficit' || f.family === 'queue') a.links = [[SITE + '/svodka-' + f.slug.replace(/^(deficit|ocheredi)-/, '').replace(/-\d{8}$/, '') + '.html', 'Сводка по городу'], [SITE + '/', 'Живая карта']];
if (f.family === 'acc') a.links = [[SITE + '/', 'Живая карта и окна привоза'], [SITE + '/svodka.html', 'Сводка по югу']];
fs.writeFileSync(path.join(newsDir, a.slug + '.html'), page(a));
manifest[a.slug] = new Date(a.t).toISOString();
items.push(a);
console.log('✓ /news/' + a.slug + '.html [' + a.variant + '] — ' + a.title);
}
if (!items.length) console.log('newsroom: новых поводов нет (проверено: ' + found.length + ')');
// индекс
const all = Object.keys(manifest).sort().reverse().slice(0, 60);
const idxItems = all.map(slug => {
let title = slug, when = manifest[slug];
try {
const h = fs.readFileSync(path.join(newsDir, slug + '.html'), 'utf8');
const m = h.match(/<h1>([\s\S]*?)<\/h1>/);
if (m) title = m[1].replace(/<[^>]+>/g, '').trim();
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
// RSS
const rssItems = items.concat(all.slice(items.length).map(slug => ({ slug, t: new Date(manifest[slug]).getTime() })))
.sort((a, b) => b.t - a.t).slice(0, 50).map(a => {
let title = a.title || a.slug, lead = a.lead || '';
try {
const h = fs.readFileSync(path.join(newsDir, a.slug + '.html'), 'utf8');
const m1 = h.match(/<h1>([\s\S]*?)<\/h1>/), m2 = h.match(/class="lead">([\s\S]*?)<\/p>/);
if (m1) title = m1[1].replace(/<[^>]+>/g, '').trim();
if (m2) lead = m2[1].replace(/<[^>]+>/g, '').trim();
} catch (e) {}
return '<item><title>' + esc(title) + '</title><link>' + SITE + '/news/' + a.slug + '.html</link>' +
'<guid isPermaLink="true">' + SITE + '/news/' + a.slug + '.html</guid>' +
'<pubDate>' + new Date(a.t).toUTCString() + '</pubDate>' +
'<description>' + esc(lead) + '</description></item>';
}).join('\n');
fs.writeFileSync(path.join(newsDir, 'rss.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n' +
'<title>КогдаБенз — новости топлива</title><link>' + SITE + '/news/</link>\n' +
'<description>Волны дефицита, возвраты топлива, очереди и точность прогнозов привоза по данным живой карты.</description>\n' +
'<language>ru</language><lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>\n' + rssItems + '\n</channel></rss>');
// news-sitemap
const nowT = Date.now();
const newsUrls = Object.keys(manifest).filter(s => nowT - new Date(manifest[s]).getTime() < 48 * H).map(s =>
'<url><loc>' + SITE + '/news/' + s + '.html</loc><news:news><news:publication><news:name>КогдаБенз</news:name><news:language>ru</news:language></news:publication><news:publication_date>' + manifest[s] + '</news:publication_date><news:title>КогдаБенз: выпуск данных</news:title></news:news></url>').join('\n');
fs.writeFileSync(path.join(dir, 'sitemap-news.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/news-sitemap">\n' + newsUrls + '\n</urlset>');
// основной sitemap
const sp = path.join(dir, 'sitemap.xml');
let sm = fs.existsSync(sp) ? fs.readFileSync(sp, 'utf8') : '';
if (sm.indexOf('<urlset') < 0) sm = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>';
if (sm.indexOf(SITE + '/news/') < 0) {
const add = ['  <url><loc>' + SITE + '/news/</loc><changefreq>hourly</changefreq><priority>0.7</priority></url>']
.concat(Object.keys(manifest).map(s => '  <url><loc>' + SITE + '/news/' + s + '.html</loc><changefreq>daily</changefreq><priority>0.6</priority></url>')).join('\n');
sm = sm.replace(/<\/urlset>/i, add + '\n</urlset>');
fs.writeFileSync(sp, sm);
}
// ссылка на новости со сводок и главной
(function injectNewsLinks() {
try {
const total = Object.keys(manifest).length;
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
fs.writeFileSync(path.join(newsDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log('newsroom: статей добавлено ' + items.length + ', всего в индексе ' + Object.keys(manifest).length + ', метрик собрано ' + D.met.length);
if (NO_GIT) { console.log('Публикация пропущена (--no-git).'); return; }
if (!fs.existsSync(path.join(dir, '.git'))) { console.log('! нет .git — закоммить вручную.'); return; }
try {
const cp = require('child_process');
const gr = c => cp.execSync(c, { cwd: dir, stdio: 'pipe', timeout: 120000 });
gr('git add -A');
try { gr('git -c user.name="kogdabenz-bot" -c user.email="bot@kogdabenz.ru" commit -m "newsroom v2: auto news"'); } catch (e) {}
gr('git push');
console.log('Опубликовано.');
} catch (e) { console.log('! git push: ' + String(e.message).split('\n')[0]); }
})().catch(e => { console.log('! newsroom: ' + e.message); process.exit(1); });