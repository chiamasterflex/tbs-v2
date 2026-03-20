import json
from pathlib import Path
from copy import deepcopy

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "Resources"
ING = RES / "ingested"

SACRED_MAIN = RES / "sacred_entities.json"
PHRASE_MAIN = RES / "phrase_memory.json"
CEREMONY_MAIN = RES / "ceremony_memory.json"

SACRED_ING = ING / "tbsn_sacred_entities.json"
PHRASE_ING = ING / "tbsn_phrase_memory.json"
CEREMONY_ING = ING / "tbsn_ritual_terms.json"
MULTI_ING = ING / "tbsn_multilingual_map.json"


def read_json(path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def norm(s):
    return (s or "").strip()


def merge_by_key(existing, incoming, key_fn, prefer_incoming=False):
    seen = {}

    for row in existing:
        key = key_fn(row)
        if key:
            seen[key] = deepcopy(row)

    for row in incoming:
        key = key_fn(row)
        if not key:
            continue

        if key not in seen:
            seen[key] = deepcopy(row)
        else:
            merged = deepcopy(seen[key])

            for k, v in row.items():
                if v in (None, "", [], {}):
                    continue

                if isinstance(v, list):
                    prev = merged.get(k, [])
                    if not isinstance(prev, list):
                        prev = []
                    merged[k] = list(dict.fromkeys(prev + v))
                else:
                    if prefer_incoming or merged.get(k) in (None, "", [], {}):
                        merged[k] = v

            seen[key] = merged

    return list(seen.values())


def enrich_sacred(rows):
    out = []
    for row in rows:
        r = deepcopy(row)
        r.setdefault("aliases", [])
        r.setdefault("mishears", [])
        r.setdefault("variants", [])
        r.setdefault("keywords", [])
        r.setdefault("source_type", "tbsn_official")
        r.setdefault("weight", 3)
        out.append(r)
    return out


def enrich_phrase(rows, default_event="General"):
    out = []
    for row in rows:
        r = deepcopy(row)
        r.setdefault("source_lang", "zh")
        r.setdefault("target_lang", "en")
        r.setdefault("event_mode", default_event)
        r.setdefault("source_type", "tbsn_official")
        r.setdefault("weight", 3)
        out.append(r)
    return out


def convert_ritual_terms_to_ceremony_memory(rows):
    out = []
    for row in rows:
        cn = norm(row.get("cn"))
        en = norm(row.get("en"))
        if not cn or not en:
            continue

        out.append({
            "cn": cn,
            "en": en,
            "event_mode": "Liturgy" if row.get("category") in ("ritual", "ceremony") else "General",
            "category": row.get("category", "ritual"),
            "source_type": row.get("source_type", "tbsn_official"),
            "weight": row.get("weight", 3),
            "source_url": row.get("source_url", "")
        })
    return out


def apply_multilingual_map_to_sacred(sacred_rows, multilingual_rows):
    by_cn = {norm(r.get("cn")): deepcopy(r) for r in sacred_rows if norm(r.get("cn"))}

    for row in multilingual_rows:
        cn = norm(row.get("cn"))
        if not cn or cn not in by_cn:
            continue

        target = by_cn[cn]
        if norm(row.get("en")):
            target["en"] = row["en"]
        if norm(row.get("id")):
            target["id"] = row["id"]

        by_cn[cn] = target

    return list(by_cn.values())


def main():
    sacred_main = read_json(SACRED_MAIN, [])
    phrase_main = read_json(PHRASE_MAIN, [])
    ceremony_main = read_json(CEREMONY_MAIN, [])

    sacred_ing = enrich_sacred(read_json(SACRED_ING, []))
    phrase_ing = enrich_phrase(read_json(PHRASE_ING, []), default_event="General")
    ritual_ing = enrich_phrase(
        convert_ritual_terms_to_ceremony_memory(read_json(CEREMONY_ING, [])),
        default_event="Liturgy"
    )
    multilingual_ing = read_json(MULTI_ING, [])

    merged_sacred = merge_by_key(
        sacred_main,
        sacred_ing,
        key_fn=lambda r: norm(r.get("cn")) or norm(r.get("en")),
        prefer_incoming=False,
    )
    merged_sacred = apply_multilingual_map_to_sacred(merged_sacred, multilingual_ing)

    merged_phrase = merge_by_key(
        phrase_main,
        phrase_ing,
        key_fn=lambda r: f"{norm(r.get('source_lang'))}|{norm(r.get('target_lang'))}|{norm(r.get('cn'))}|{norm(r.get('en'))}",
        prefer_incoming=False,
    )

    merged_ceremony = merge_by_key(
        ceremony_main,
        ritual_ing,
        key_fn=lambda r: f"{norm(r.get('cn'))}|{norm(r.get('en'))}|{norm(r.get('event_mode'))}",
        prefer_incoming=False,
    )

    write_json(SACRED_MAIN, merged_sacred)
    write_json(PHRASE_MAIN, merged_phrase)
    write_json(CEREMONY_MAIN, merged_ceremony)

    print(f"Merged sacred_entities.json: {len(merged_sacred)} rows")
    print(f"Merged phrase_memory.json: {len(merged_phrase)} rows")
    print(f"Merged ceremony_memory.json: {len(merged_ceremony)} rows")


if __name__ == "__main__":
    main()