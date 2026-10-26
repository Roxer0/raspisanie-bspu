/* ============================================================
   Расписание БГПУ · группа 280624 — Telegram Mini App
   Данные: schedule.json (собирается из ttable.bspu.by)
   ============================================================ */

(function () {
  'use strict';

  var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  var MINSK_TZ = 'Europe/Minsk';
  var CACHE_KEY = 'bspu-280624-schedule-v1';
  var SUBGROUP_KEY = 'bspu-280624-subgroup';
  var REQUEST_TTL = 30 * 60 * 1000;

  var WEEKDAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
  var WEEKDAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  var MONTHS = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
  ];
  var MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  var ICONS = {
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11Z"/><circle cx="12" cy="10" r="2.4"/></svg>',
    person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="3.4"/><path d="M5.2 20c.6-3.6 3.4-6 6.8-6s6.2 2.4 6.8 6"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="16" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8.5 14.5h2M13.5 14.5h2M8.5 18h2M13.5 18h2"/></svg>',
    offline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5a15 15 0 0 1 5.2-2.7M14 5.6A15 15 0 0 1 21 8.5M6 12.2a10 10 0 0 1 3.2-1.7M14.8 10.6a10 10 0 0 1 3.2 1.6M9 15.7a5 5 0 0 1 6 0M12 19h.01"/><path d="M3 3l18 18"/></svg>'
  };

  var SUBJECT_COLORS = [
    ['дизартри', '#ff7a59'],
    ['фонетико', '#7c8cff'],
    ['технология логопедического', '#3fb6d9'],
    ['дифференциальная диагностика', '#6fa8ff'],
    ['методика познавательного', '#ef6fa8'],
    ['основы коррекционно', '#2fbf9f'],
    ['личностно-профессиональное', '#9b7cff'],
    ['культура речи', '#3fbf74'],
    ['профессиональная речь', '#f2a33c'],
    ['организационно', '#8a97ff']
  ];
  var FALLBACK_COLORS = ['#6c4bf4', '#3fa9f5', '#2fbf9f', '#ef6fa8', '#f2a33c', '#7c8cff'];

  var state = {
    data: null,
    source: 'none',
    loading: true,
    error: null,
    subgroup: readSubgroup(),
    tab: 'today',
    weekOffset: 0,
    sheetOpen: false,
    refreshing: false,
    dayIso: null,
    lastAttempt: 0,
    contentHash: ''
  };

  /* ------------------------------------------------------------
     Даты и время (всегда по Минску)
     ------------------------------------------------------------ */

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function minskNow() {
    var parts = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: MINSK_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date()).forEach(function (part) {
      parts[part.type] = part.value;
    });
    var iso = parts.year + '-' + parts.month + '-' + parts.day;
    return {
      iso: iso,
      minutes: Number(parts.hour) * 60 + Number(parts.minute)
    };
  }

  function toUtc(iso) {
    var parts = iso.split('-').map(Number);
    return Date.UTC(parts[0], parts[1] - 1, parts[2]);
  }

  function isoOf(date) {
    return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
  }

  function addDays(iso, count) {
    return isoOf(new Date(toUtc(iso) + count * 86400000));
  }

  function daysBetween(from, to) {
    return Math.round((toUtc(to) - toUtc(from)) / 86400000);
  }

  function weekdayMon0(iso) {
    return (new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7;
  }

  function mondayOf(iso) {
    return addDays(iso, -weekdayMon0(iso));
  }

  function dateParts(iso) {
    var parts = iso.split('-').map(Number);
    return { y: parts[0], m: parts[1], d: parts[2] };
  }

  function formatLong(iso) {
    var p = dateParts(iso);
    return p.d + ' ' + MONTHS[p.m - 1];
  }

  function formatShort(iso) {
    var p = dateParts(iso);
    return pad(p.d) + '.' + pad(p.m);
  }

  function formatRange(startIso, endIso) {
    var a = dateParts(startIso);
    var b = dateParts(endIso);
    if (a.m === b.m) return a.d + '–' + b.d + ' ' + MONTHS[a.m - 1];
    return a.d + ' ' + MONTHS_SHORT[a.m - 1] + ' – ' + b.d + ' ' + MONTHS_SHORT[b.m - 1];
  }

  function hm(minutes) {
    return Math.floor(minutes / 60) + ':' + pad(minutes % 60);
  }

  function humanDuration(minutes) {
    if (minutes <= 0) return 'меньше минуты';
    if (minutes < 60) return minutes + ' мин';
    var hours = Math.floor(minutes / 60);
    var rest = minutes % 60;
    return hours + ' ч' + (rest > 0 ? ' ' + rest + ' мин' : '');
  }

  function formatStamp(value) {
    var date = new Date(value);
    if (isNaN(date.getTime())) return 'неизвестно';
    var parts = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: MINSK_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(date).forEach(function (part) {
      parts[part.type] = part.value;
    });
    var iso = parts.year + '-' + parts.month + '-' + parts.day;
    var time = parts.hour + ':' + parts.minute;
    var diff = daysBetween(iso, minskNow().iso);
    if (diff <= 0) return 'сегодня, ' + time;
    if (diff === 1) return 'вчера, ' + time;
    var p = dateParts(iso);
    return p.d + ' ' + MONTHS[p.m - 1] + ', ' + time;
  }

  function isoOfStamp(value) {
    var parts = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: MINSK_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date(value)).forEach(function (part) {
      parts[part.type] = part.value;
    });
    return parts.year + '-' + parts.month + '-' + parts.day;
  }

  /* ------------------------------------------------------------
     Данные расписания
     ------------------------------------------------------------ */

  function readJson(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      /* приватный режим — обойдёмся без кэша */
    }
  }

  function readSubgroup() {
    try {
      var saved = Number(localStorage.getItem(SUBGROUP_KEY));
      return saved === 1 ? 1 : 2;
    } catch (error) {
      return 2;
    }
  }

  function saveSubgroup(value) {
    try {
      localStorage.setItem(SUBGROUP_KEY, String(value));
    } catch (error) {
      /* не критично */
    }
  }

  function isScheduleValid(data) {
    return Boolean(
      data &&
      data.reference &&
      data.weeks &&
      data.weeks.odd &&
      data.weeks.even
    );
  }

  function hashOf(data) {
    if (!data) return '';
    return JSON.stringify([data.reference, data.referenceParity, data.weeks]);
  }

  function parityOf(iso) {
    if (!state.data) return 0;
    var monday = mondayOf(iso);
    var weeks = Math.floor(daysBetween(state.data.reference, monday) / 7);
    return ((Number(state.data.referenceParity || 0) + weeks) % 2 + 2) % 2;
  }

  function parityLabel(parity) {
    return parity === 0 ? 'нечётная неделя' : 'чётная неделя';
  }

  function lessonsFor(iso) {
    if (!state.data) return [];
    var weekday = weekdayMon0(iso);
    if (weekday > 5) return [];
    var week = parityOf(iso) === 0 ? state.data.weeks.odd : state.data.weeks.even;
    var list = (week && week[String(weekday + 1)]) || [];
    return list.filter(function (lesson) {
      return lesson.subgroup === 0 || lesson.subgroup === state.subgroup;
    });
  }

  function nextStudyDay(iso, includeToday) {
    var start = includeToday ? 0 : 1;
    for (var offset = start; offset <= 10; offset++) {
      var day = addDays(iso, offset);
      var lessons = lessonsFor(day);
      if (lessons.length > 0) return { iso: day, lessons: lessons };
    }
    return null;
  }

  function pluralPairs(count) {
    var mod10 = count % 10;
    var mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'пара';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'пары';
    return 'пар';
  }

  /* ------------------------------------------------------------
     Отображение данных: подписи и цвета
     ------------------------------------------------------------ */

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function shortTeacher(value) {
    var text = String(value || '')
      .replace(/^(ст\.\s*преп\.|доц\.|пр\.-ст|проф\.|асс\.|преп\.)\s*/i, '')
      .trim();
    var parts = text.split(/\s+/).filter(Boolean);
    if (parts.length >= 3) {
      var surname = parts.slice(0, -2).join(' ');
      var first = parts[parts.length - 2].charAt(0);
      var patronymic = parts[parts.length - 1].charAt(0);
      return surname + ' ' + first + '.' + patronymic + '.';
    }
    return text;
  }

  function roomLabel(room) {
    var value = String(room || '').trim();
    if (!value) return '';
    return value.indexOf('на базе') === 0 ? 'на базе учреждения' : value;
  }

  function liveRoom(room) {
    var label = roomLabel(room);
    return label.indexOf('на базе') === 0 ? '' : label;
  }

  function typeLabel(type) {
    var value = String(type || '');
    if (/лекц/i.test(value)) return 'лекция';
    if (/лаборатор/i.test(value)) return 'лабораторная';
    if (/практич/i.test(value)) return 'практика';
    return value;
  }

  function typeClass(type) {
    var value = String(type || '');
    if (/лекц/i.test(value)) return 'lecture';
    if (/лаборатор/i.test(value)) return 'lab';
    if (/практич/i.test(value)) return 'practice';
    return 'other';
  }

  function subjectColor(title) {
    var value = String(title || '').toLowerCase();
    for (var i = 0; i < SUBJECT_COLORS.length; i++) {
      if (value.indexOf(SUBJECT_COLORS[i][0]) !== -1) return SUBJECT_COLORS[i][1];
    }
    var hash = 0;
    for (var j = 0; j < value.length; j++) {
      hash = (hash * 31 + value.charCodeAt(j)) >>> 0;
    }
    return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
  }

  function dayName(iso) {
    return WEEKDAYS[weekdayMon0(iso)];
  }

  /* ------------------------------------------------------------
     Экраны
     ------------------------------------------------------------ */

  function livePanel(now) {
    var lessons = lessonsFor(now.iso);
    var current = null;
    var next = null;
    lessons.forEach(function (lesson) {
      if (!current && now.minutes >= lesson.start && now.minutes < lesson.end) current = lesson;
      if (!next && lesson.start > now.minutes) next = lesson;
    });

    if (current) {
      var remaining = current.end - now.minutes;
      var progress = Math.min(1, Math.max(0, (now.minutes - current.start) / (current.end - current.start)));
      var currentRoom = liveRoom(current.room);
      return '' +
        '<div class="live">' +
          '<div class="live-label"><span class="pulse"></span>Сейчас идёт</div>' +
          '<div class="live-title">' + esc(current.title) + '</div>' +
          '<div class="live-foot"><span>' + hm(current.start) + '–' + hm(current.end) +
            (currentRoom ? ' · ' + esc(currentRoom) : '') + '</span>' +
            '<b>осталось ' + humanDuration(remaining) + '</b></div>' +
          '<div class="progress"><i style="width:' + (progress * 100).toFixed(1) + '%"></i></div>' +
        '</div>';
    }

    if (next) {
      var nextRoom = liveRoom(next.room);
      return '' +
        '<div class="live">' +
          '<div class="live-label"><span class="pulse"></span>Следующая пара</div>' +
          '<div class="live-title">' + esc(next.title) + '</div>' +
          '<div class="live-foot"><span>' + hm(next.start) +
            (nextRoom ? ' · ' + esc(nextRoom) : '') + '</span>' +
            '<b>через ' + humanDuration(next.start - now.minutes) + '</b></div>' +
        '</div>';
    }

    var upcoming = nextStudyDay(now.iso, false);

    if (lessons.length > 0) {
      var tailUpcoming = upcoming;
      var tomorrow = addDays(now.iso, 1);
      return '' +
        '<div class="live is-calm">' +
          '<div class="live-label"><span class="pulse"></span>На сегодня всё</div>' +
          '<div class="live-title">' + (tailUpcoming
            ? (tailUpcoming.iso === tomorrow ? 'Завтра' : dayName(tailUpcoming.iso))
            : 'Свободно') + '</div>' +
          '<div class="live-foot"><span>' + (tailUpcoming
            ? dayName(tailUpcoming.iso) + ', ' + formatLong(tailUpcoming.iso) + ' · ' +
              tailUpcoming.lessons.length + ' ' + pluralPairs(tailUpcoming.lessons.length)
            : 'На этой неделе пар больше нет') + '</span><b></b></div>' +
        '</div>';
    }

    return '' +
      '<div class="live is-calm">' +
        '<div class="live-label"><span class="pulse"></span>Пар сегодня нет</div>' +
        '<div class="live-title">' + (upcoming ? dayName(upcoming.iso) + ', ' + formatLong(upcoming.iso) : 'Выходной') + '</div>' +
        '<div class="live-foot">' +
          '<span>' + (upcoming
            ? upcoming.lessons.length + ' ' + pluralPairs(upcoming.lessons.length) +
              ' · первая в ' + hm(upcoming.lessons[0].start)
            : 'Ближайших пар не нашлось') + '</span><b></b>' +
        '</div>' +
      '</div>';
  }

  function lessonCard(lesson, now, isToday) {
    var isNow = isToday && now.minutes >= lesson.start && now.minutes < lesson.end;
    var isPast = isToday && now.minutes >= lesson.end;
    var classes = 'lesson' + (isNow ? ' is-now' : '') + (isPast ? ' is-past' : '');

    return '' +
      '<article class="' + classes + '"' +
        ' data-start="' + lesson.start + '" data-end="' + lesson.end + '"' +
        (isToday ? ' data-today="1"' : '') +
        ' style="--accent:' + subjectColor(lesson.title) + '">' +
        '<span class="lesson-bar" aria-hidden="true"></span>' +
        '<div class="lesson-main">' +
          '<div class="lesson-top">' +
            '<span class="lesson-time">' + hm(lesson.start) +
              '<span class="dash">–</span>' + hm(lesson.end) + '</span>' +
            (lesson.type
              ? '<span class="type-chip ' + typeClass(lesson.type) + '">' + esc(typeLabel(lesson.type)) + '</span>'
              : '') +
          '</div>' +
          '<h3>' + esc(lesson.title) + '</h3>' +
          '<div class="lesson-meta">' +
            (lesson.room
              ? '<span class="meta">' + ICONS.pin + '<span>' + esc(roomLabel(lesson.room)) + '</span></span>'
              : '') +
            (lesson.teacher
              ? '<span class="meta">' + ICONS.person + '<span>' + esc(shortTeacher(lesson.teacher)) + '</span></span>'
              : '') +
          '</div>' +
        '</div>' +
        '<div class="lesson-progress" aria-hidden="true"><i></i></div>' +
      '</article>';
  }

  function sectionHeadHtml(title, count) {
    return '' +
      '<div class="section-head">' +
        '<h2>' + esc(title) + '</h2>' +
        (count > 0
          ? '<span class="count">' + count + ' ' + pluralPairs(count) + '</span>'
          : '') +
      '</div>';
  }

  function todayHtml(now) {
    var lessons = lessonsFor(now.iso);
    var parity = parityOf(now.iso);
    var upcoming = nextStudyDay(now.iso, false);
    var content;

    if (lessons.length > 0) {
      content = sectionHeadHtml('Пары сегодня', lessons.length) +
        '<div class="lessons">' + lessons.map(function (lesson) {
          return lessonCard(lesson, now, true);
        }).join('') + '</div>';
    } else if (upcoming) {
      content = sectionHeadHtml(dayName(upcoming.iso) + ', ' + formatLong(upcoming.iso), upcoming.lessons.length) +
        '<div class="lessons">' + upcoming.lessons.map(function (lesson) {
          return lessonCard(lesson, now, false);
        }).join('') + '</div>';
    } else {
      content = sectionHeadHtml('Сегодня', 0) +
        '<div class="empty">' +
          '<div class="empty-art">' + ICONS.calendar + '</div>' +
          '<h3>Пар сегодня нет</h3>' +
          '<p>На этой неделе пар больше не будет.</p>' +
        '</div>';
    }

    return '' +
      '<section class="hero">' +
        '<div class="hero-top">' +
          '<span class="eyebrow">Сегодня</span>' +
          '<div class="hero-chips">' +
            '<span class="chip">' + parityLabel(parity) + '</span>' +
            '<span class="chip">' + state.subgroup + '-я подгруппа</span>' +
          '</div>' +
        '</div>' +
        '<h1>' + WEEKDAYS[weekdayMon0(now.iso)] + '</h1>' +
        '<p class="hero-date">' + formatLong(now.iso) + '</p>' +
        '<div id="live-panel">' + livePanel(now) + '</div>' +
      '</section>' +
      content;
  }

  function weekHtml(now) {
    var currentMonday = mondayOf(now.iso);
    var offset = state.weekOffset === 1 ? 1 : 0;
    var start = addDays(currentMonday, offset * 7);
    var end = addDays(start, 5);
    var parity = parityOf(start);

    var total = 0;
    var days = '';
    for (var i = 0; i < 6; i++) {
      var iso = addDays(start, i);
      var lessons = lessonsFor(iso);
      total += lessons.length;
      var isToday = iso === now.iso;

      var body = lessons.length > 0
        ? '<div class="lessons">' + lessons.map(function (lesson) {
            return lessonCard(lesson, now, isToday);
          }).join('') + '</div>'
        : '<div class="day-empty">Пар нет</div>';

      days += '' +
        '<section class="day">' +
          '<div class="day-head">' +
            '<span class="day-name">' + WEEKDAYS[weekdayMon0(iso)] + '</span>' +
            '<span class="day-date">' + formatShort(iso) + '</span>' +
            '<div class="day-side">' +
              (isToday ? '<span class="today-chip">сегодня</span>' : '') +
              (lessons.length > 0
                ? '<span class="day-count">' + lessons.length + ' ' + pluralPairs(lessons.length) + '</span>'
                : '') +
            '</div>' +
          '</div>' +
          body +
        '</section>';
    }

    var week0Start = currentMonday;
    var week0End = addDays(currentMonday, 5);
    var week1Start = addDays(currentMonday, 7);
    var week1End = addDays(currentMonday, 12);

    return '' +
      '<section class="hero">' +
        '<div class="hero-top">' +
          '<span class="eyebrow">Расписание</span>' +
          '<div class="hero-chips"><span class="chip">' + state.subgroup + '-я подгруппа</span></div>' +
        '</div>' +
        '<h1>' + (parity === 0 ? 'Нечётная неделя' : 'Чётная неделя') + '</h1>' +
        '<p class="hero-date">' + formatRange(start, end) + ' · ' + total + ' ' + pluralPairs(total) + '</p>' +
      '</section>' +
      '<div class="week-switch" role="group" aria-label="Неделя">' +
        '<button type="button" data-offset="0" class="' + (offset === 0 ? 'active' : '') + '">' +
          '<small>Эта неделя</small>' +
          '<b>' + formatRange(week0Start, week0End) + '</b>' +
        '</button>' +
        '<button type="button" data-offset="1" class="' + (offset === 1 ? 'active' : '') + '">' +
          '<small>Следующая</small>' +
          '<b>' + formatRange(week1Start, week1End) + '</b>' +
        '</button>' +
      '</div>' +
      days;
  }

  function loadingHtml() {
    return '<div class="loading"><div class="spinner"></div><span>Загружаем расписание…</span></div>';
  }

  function staleNotice() {
    if (!state.data) return '';
    var checked = state.data.checkedAt || state.data.updatedAt;
    if (!checked) return '';
    var days = daysBetween(isoOfStamp(checked), minskNow().iso);
    if (days < 3) return '';

    var p = dateParts(isoOfStamp(checked));
    return '' +
      '<div class="notice" role="status">' +
        '<span class="notice-dot" aria-hidden="true"></span>' +
        '<span>Данные от ' + p.d + ' ' + MONTHS_SHORT[p.m - 1] + ' — могли устареть</span>' +
        '<button type="button" data-retry>Обновить</button>' +
      '</div>';
  }

  function errorHtml() {
    return '' +
      '<div class="empty" style="margin-top:20px">' +
        '<div class="empty-art">' + ICONS.offline + '</div>' +
        '<h3>Нет связи с расписанием</h3>' +
        '<p>Не удалось загрузить данные. Проверьте интернет и попробуйте ещё раз.</p>' +
        '<button class="btn primary" type="button" id="retry">Повторить</button>' +
      '</div>';
  }

  /* ------------------------------------------------------------
     Отрисовка и обновление состояния
     ------------------------------------------------------------ */

  function render(options) {
    var animate = options && options.animate;
    var screen = document.getElementById('screen');
    if (!screen) return;

    if (!state.data) {
      screen.innerHTML = state.loading ? loadingHtml() : errorHtml();
      updateTabs();
      updateDataStatus();
      return;
    }

    var now = minskNow();
    state.dayIso = now.iso;
    screen.innerHTML = staleNotice() + (state.tab === 'today' ? todayHtml(now) : weekHtml(now));

    if (animate) {
      screen.classList.remove('anim');
      void screen.offsetWidth;
      screen.classList.add('anim');
    }

    updateTabs();
    updateDataStatus();
    updateLessonStates(now);
  }

  function updateTabs() {
    var buttons = document.querySelectorAll('.tab-btn');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('active', buttons[i].getAttribute('data-tab') === state.tab);
    }
  }

  function updateLessonStates(now) {
    var cards = document.querySelectorAll('.lesson[data-today="1"]');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var start = Number(card.getAttribute('data-start'));
      var end = Number(card.getAttribute('data-end'));
      var isNow = now.minutes >= start && now.minutes < end;
      var isPast = now.minutes >= end;
      card.classList.toggle('is-now', isNow);
      card.classList.toggle('is-past', isPast);
      var bar = card.querySelector('.lesson-progress i');
      if (bar) {
        var width = isNow ? Math.min(100, Math.max(0, ((now.minutes - start) / (end - start)) * 100)) : 0;
        bar.style.width = width.toFixed(1) + '%';
      }
    }
  }

  function tick() {
    if (!state.data) return;
    var now = minskNow();

    if (state.dayIso && state.dayIso !== now.iso) {
      render();
      return;
    }

    var panel = document.getElementById('live-panel');
    if (panel) panel.innerHTML = livePanel(now);
    updateLessonStates(now);
  }

  function updateDataStatus() {
    var status = document.getElementById('data-status');
    if (!status) return;

    var source = document.getElementById('data-source');
    var note = document.getElementById('data-note');

    if (!state.data) {
      status.textContent = state.loading ? 'Загружаем…' : 'Нет данных';
      source.textContent = 'ttable.bspu.by';
      if (note) note.hidden = true;
      return;
    }

    var checked = state.data.checkedAt || state.data.updatedAt;
    status.textContent = 'Проверено ' + formatStamp(checked);
    source.textContent = 'ttable.bspu.by · группа ' + (state.data.group || '280624') +
      (state.source === 'network' ? '' : ' · сохранено на телефоне');

    if (note) {
      var staleDays = 0;
      if (checked) {
        staleDays = daysBetween(isoOfStamp(checked), minskNow().iso);
      }
      if (staleDays >= 3) {
        note.hidden = false;
        note.textContent = 'Данные не обновлялись ' + staleDays + ' дн. — возможно, пропала связь с сайтом.';
      } else if (state.error) {
        note.hidden = false;
        note.textContent = 'Последняя попытка обновления не удалась — показаны сохранённые данные.';
      } else {
        note.hidden = true;
      }
    }
  }

  function toast(message) {
    var element = document.getElementById('toast');
    if (!element) return;
    element.textContent = message;
    element.hidden = false;
    requestAnimationFrame(function () {
      element.classList.add('show');
    });
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () {
      element.classList.remove('show');
      setTimeout(function () {
        element.hidden = true;
      }, 220);
    }, 2400);
  }

  /* ------------------------------------------------------------
     Загрузка данных
     ------------------------------------------------------------ */

  function loadSchedule(force) {
    var now = Date.now();
    if (!force && state.lastAttempt && now - state.lastAttempt < REQUEST_TTL) {
      return Promise.resolve();
    }
    state.lastAttempt = now;

    if (!state.data) {
      state.loading = true;
      render();
    }

    return fetch('schedule.json?v=' + now, { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        if (!isScheduleValid(data)) throw new Error('Некорректные данные');

        var previousChecked = state.data ? (state.data.checkedAt || state.data.updatedAt) : null;
        var hasContentChanged = hashOf(data) !== state.contentHash;
        var firstLoad = !state.data;
        var scrollY = window.scrollY;

        state.data = data;
        state.source = 'network';
        state.error = null;
        state.contentHash = hashOf(data);
        state.loading = false;
        writeJson(CACHE_KEY, data);

        if (firstLoad || hasContentChanged || state.tab === 'today') {
          render();
          if (!firstLoad) window.scrollTo(0, scrollY);
        } else {
          updateDataStatus();
        }

        if (force) {
          var newChecked = data.checkedAt || data.updatedAt;
          if (previousChecked && newChecked === previousChecked) {
            toast('На сервере пока старая версия — попробуйте позже');
          } else {
            toast('Расписание обновлено');
          }
        }
      })
      .catch(function (error) {
        state.error = error;
        state.loading = false;

        if (!state.data) {
          var cached = readJson(CACHE_KEY);
          if (isScheduleValid(cached)) {
            state.data = cached;
            state.source = 'cache';
            state.contentHash = hashOf(cached);
            render();
          } else {
            render();
          }
        } else {
          updateDataStatus();
        }

        if (force) toast('Нет связи — показываем сохранённое');
      });
  }

  /* ------------------------------------------------------------
     Настройки
     ------------------------------------------------------------ */

  function openSheet() {
    if (state.sheetOpen) return;
    state.sheetOpen = true;
    var sheet = document.getElementById('sheet');
    sheet.hidden = false;
    document.body.classList.add('sheet-open');
    refreshSheet();
    requestAnimationFrame(function () {
      sheet.classList.add('open');
    });
    if (tg && tg.BackButton) tg.BackButton.show();
    if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
  }

  function closeSheet() {
    if (!state.sheetOpen) return;
    state.sheetOpen = false;
    var sheet = document.getElementById('sheet');
    sheet.classList.remove('open');
    document.body.classList.remove('sheet-open');
    if (tg && tg.BackButton) tg.BackButton.hide();
    setTimeout(function () {
      if (!state.sheetOpen) sheet.hidden = true;
    }, 300);
  }

  function refreshSheet() {
    var buttons = document.querySelectorAll('#subgroup-seg button');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('active', Number(buttons[i].getAttribute('data-subgroup')) === state.subgroup);
    }
    updateDataStatus();
  }

  function setRefreshing(value) {
    state.refreshing = value;
    var button = document.getElementById('refresh-btn');
    if (!button) return;
    button.disabled = value;
    button.textContent = value ? 'Обновляем…' : 'Обновить';
  }

  /* ------------------------------------------------------------
     Telegram и оформление
     ------------------------------------------------------------ */

  function applyTheme() {
    var dark = tg
      ? tg.colorScheme === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', dark);
    if (tg && tg.setBackgroundColor) {
      tg.setBackgroundColor(dark ? '#131118' : '#f1eff8');
    }
  }

  function setupTelegram() {
    if (!tg) return;
    try {
      tg.ready();
      tg.expand();
      if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
      if (tg.setHeaderColor) tg.setHeaderColor('#4b2acb');
      if (tg.BackButton) {
        tg.BackButton.onClick(function () {
          if (state.sheetOpen) closeSheet();
        });
        tg.BackButton.hide();
      }
      tg.onEvent('themeChanged', function () {
        applyTheme();
        render();
      });
    } catch (error) {
      /* вне Telegram приложение тоже работает */
    }
  }

  /* ------------------------------------------------------------
     События
     ------------------------------------------------------------ */

  function initEvents() {
    document.getElementById('open-settings').addEventListener('click', openSheet);
    document.getElementById('close-sheet').addEventListener('click', closeSheet);

    document.getElementById('sheet').addEventListener('click', function (event) {
      if (event.target === event.currentTarget) closeSheet();
    });

    document.getElementById('subgroup-seg').addEventListener('click', function (event) {
      var button = event.target.closest('button[data-subgroup]');
      if (!button) return;
      var value = Number(button.getAttribute('data-subgroup'));
      if (value === state.subgroup) return;
      state.subgroup = value;
      saveSubgroup(value);
      refreshSheet();
      render();
      if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
      toast('Показываем ' + value + '-ю подгруппу');
    });

    document.getElementById('refresh-btn').addEventListener('click', function () {
      if (state.refreshing) return;
      setRefreshing(true);
      loadSchedule(true).then(function () {
        setRefreshing(false);
        updateDataStatus();
      });
    });

    document.getElementById('site-link').addEventListener('click', function (event) {
      if (!tg || !tg.openLink) return;
      event.preventDefault();
      tg.openLink(event.currentTarget.href);
    });

    document.querySelectorAll('.tab-btn').forEach(function (button) {
      button.addEventListener('click', function () {
        var tab = button.getAttribute('data-tab');
        if (tab === state.tab) return;
        state.tab = tab;
        render({ animate: true });
        if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
      });
    });

    document.getElementById('screen').addEventListener('click', function (event) {
      var weekButton = event.target.closest('[data-offset]');
      if (weekButton) {
        var offset = Number(weekButton.getAttribute('data-offset'));
        if (offset !== state.weekOffset) {
          state.weekOffset = offset;
          render({ animate: true });
          if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
        }
        return;
      }

      if (event.target.closest('#retry, [data-retry]')) {
        if (!state.data) {
          state.loading = true;
          state.error = null;
          render();
        }
        loadSchedule(true);
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.sheetOpen) closeSheet();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      tick();
      loadSchedule(false);
    });

    if (!tg) {
      var media = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () {
        applyTheme();
        render();
      };
      if (media.addEventListener) media.addEventListener('change', onChange);
    }
  }

  /* ------------------------------------------------------------
     Запуск
     ------------------------------------------------------------ */

  function boot() {
    setupTelegram();
    applyTheme();

    var cached = readJson(CACHE_KEY);
    if (isScheduleValid(cached)) {
      state.data = cached;
      state.source = 'cache';
      state.contentHash = hashOf(cached);
      state.loading = false;
    }

    state.weekOffset = weekdayMon0(minskNow().iso) === 6 ? 1 : 0;

    try {
      var params = new URLSearchParams(window.location.search);
      if (params.get('tab') === 'week') state.tab = 'week';
    } catch (error) {
      /* без параметров */
    }

    initEvents();
    render();

    loadSchedule(false);
    setInterval(tick, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
