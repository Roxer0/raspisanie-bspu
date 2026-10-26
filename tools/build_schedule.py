#!/usr/bin/env python3
"""Скачивает расписание группы 280624 с сайта БГПУ и собирает schedule.json.

Запуск:
    python tools/build_schedule.py

Скрипт используется и локально, и в GitHub Actions (см. .github/workflows).
Если сайт недоступен или вёрстка поменялась — файл не перезаписывается,
скрипт завершается с ошибкой.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

GROUP_ID = 1241
GROUP_NAME = "280624"
SITE = "https://ttable.bspu.by"
URL = SITE + "/timetable?groups={gid}&week={week}&all_week=1&ttype=pairs"

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "schedule.json"

MINSK = timezone(timedelta(hours=3))

DAY_KEYS = {
    "понедельник": 1,
    "вторник": 2,
    "среда": 3,
    "четверг": 4,
    "пятница": 5,
    "суббота": 6,
}

ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)
HEADER_RE = re.compile(
    r'<th[^>]*class="[^"]*dayHeader[^"]*"[^>]*>(.*?)</th>', re.S | re.I
)
CELL_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S | re.I)
DATE_COMMENT_RE = re.compile(r"<!--\s*,\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*-->")
TIME_RE = re.compile(r"(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})")


def clean(raw: str) -> str:
    """Убирает теги и лишние пробелы, оставляя текст."""
    text = re.sub(r"<br\s*/?>", " ", raw, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text).replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()


def parse_minutes(text: str) -> int | None:
    match = re.search(r"(\d{1,2}):(\d{2})", text)
    if not match:
        return None
    return int(match.group(1)) * 60 + int(match.group(2))


def parse_subgroup(text: str) -> int:
    value = text.lower()
    if "перв" in value:
        return 1
    if "втор" in value:
        return 2
    return 0


def iso_from_dots(value: str) -> str:
    d, m, y = (int(part) for part in value.split("."))
    return f"{y:04d}-{m:02d}-{d:02d}"


def parse_page(page: str, label: str) -> tuple[dict[int, list[dict]], str | None]:
    """Возвращает пары по дням (1–6) и ISO-дату первого дня."""
    start = page.lower().find('id="table-week"')
    if start == -1:
        raise ValueError(f"{label}: не найдена таблица расписания")
    end = page.lower().find("</table>", start)
    table = page[start:end if end != -1 else len(page)]

    days: dict[int, list[dict]] = {}
    first_date: str | None = None
    current = 0

    for row in ROW_RE.findall(table):
        header = HEADER_RE.search(row)
        if header:
            inner = header.group(1)
            name = clean(re.sub(r"<!--.*?-->", "", inner, flags=re.S)).lower()
            current = next(
                (key for word, key in DAY_KEYS.items() if name.startswith(word)), 0
            )
            date_match = DATE_COMMENT_RE.search(inner)
            if date_match and first_date is None:
                first_date = iso_from_dots(".".join(date_match.groups()))
            continue

        if not current:
            continue

        cells = [clean(cell) for cell in CELL_RE.findall(row)]
        if len(cells) < 6:
            continue

        time_match = TIME_RE.search(cells[0])
        title = cells[1]
        if not time_match or not title:
            continue

        lesson = {
            "start": int(time_match.group(1)) * 60 + int(time_match.group(2)),
            "end": int(time_match.group(3)) * 60 + int(time_match.group(4)),
            "title": title,
            "teacher": cells[2],
            "room": cells[3],
            "type": cells[4],
            "subgroup": parse_subgroup(cells[5]),
        }
        days.setdefault(current, []).append(lesson)

    for lessons in days.values():
        unique: dict[tuple, dict] = {}
        for lesson in lessons:
            key = (
                lesson["start"],
                lesson["end"],
                lesson["title"],
                lesson["subgroup"],
                lesson["room"],
            )
            unique.setdefault(key, lesson)
        lessons[:] = sorted(
            unique.values(),
            key=lambda item: (item["start"], item["subgroup"], item["title"]),
        )

    if not days:
        raise ValueError(f"{label}: расписание пустое")
    return days, first_date


def fetch(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RaspisanieBot/1.0",
            "Accept-Language": "ru,en;q=0.8",
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def read_previous() -> dict | None:
    try:
        with TARGET.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        if not data.get("weeks", {}).get("odd") or not data.get("reference"):
            return None
        return data
    except (OSError, ValueError):
        return None


def payload(data: dict) -> str:
    """Содержимое, которое должно измениться, чтобы перезаписывать файл."""
    return json.dumps(
        {
            "reference": data.get("reference"),
            "referenceParity": data.get("referenceParity"),
            "weeks": data.get("weeks"),
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Сборка schedule.json с сайта БГПУ")
    parser.add_argument(
        "--force", action="store_true", help="перезаписать файл даже без изменений"
    )
    args = parser.parse_args()

    now = datetime.now(MINSK).replace(microsecond=0)
    stamp = now.isoformat()

    try:
        first_html = fetch(URL.format(gid=GROUP_ID, week=1))
        second_html = fetch(URL.format(gid=GROUP_ID, week=2))

        for name, page in (("week=1", first_html), ("week=2", second_html)):
            if GROUP_NAME not in page:
                raise ValueError(f"{name}: на странице нет группы {GROUP_NAME}")

        odd_days, odd_first = parse_page(first_html, "week=1")
        even_days, _ = parse_page(second_html, "week=2")
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        print(f"Ошибка: {error}", file=sys.stderr)
        return 1

    if not odd_first:
        print("Ошибка: на странице week=1 нет дат", file=sys.stderr)
        return 1

    # Опорный понедельник: неделя, которую сайт считает первой (нечётной).
    reference_date = datetime.strptime(odd_first, "%Y-%m-%d").date()
    reference = reference_date - timedelta(days=reference_date.weekday())

    previous = read_previous()
    data = {
        "group": GROUP_NAME,
        "reference": reference.isoformat(),
        "referenceParity": 0,
        "weeks": {
            "odd": {str(day): odd_days[day] for day in sorted(odd_days)},
            "even": {str(day): even_days[day] for day in sorted(even_days)},
        },
        "updatedAt": previous.get("updatedAt") if previous else stamp,
        "checkedAt": stamp,
        "source": SITE,
    }

    changed = previous is None or payload(previous) != payload(data)
    if changed:
        data["updatedAt"] = stamp

    if not changed and not args.force:
        old_checked = previous.get("checkedAt", "") if previous else ""
        try:
            last = datetime.fromisoformat(old_checked)
        except ValueError:
            last = now - timedelta(days=2)
        if now - last < timedelta(hours=24):
            print("Расписание не изменилось, файл не трогаем.")
            return 0
        print("Расписание не изменилось, обновляем только отметку проверки.")

    TARGET.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    total = {
        key: sum(len(lessons) for lessons in week.values())
        for key, week in data["weeks"].items()
    }
    print(
        f"OK: reference={data['reference']}, "
        f"odd={total['odd']} пар, even={total['even']} пар, файл {TARGET.name}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
