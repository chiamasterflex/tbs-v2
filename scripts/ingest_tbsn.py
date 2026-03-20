import json
import re
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import List, Set
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://tbsn.org/master/index.html"
OUT_DIR = Path("Resources/ingested")
OUT_DIR.mkdir(parents=True, exist_ok=True)

SESSION = requests.Session()
SESSION.headers.update(
    {
        "User-Agent": "Mozilla/5.0 (compatible; TBS-V2-Ingester/1.0)"
    }
)

CATEGORY_NAMES = {
    "佛": "buddha",
    "菩薩": "bodhisattva",
    "金剛明王": "vidyaraja",
    "佛母": "buddha-mother",
    "度母": "tara",
    "護法": "protector",
    "祖師": "patriarch",
    "財神": "wealth-deity",
    "其他諸尊": "other",
}

KEY_CHARS = ["佛", "母", "天", "王", "師", "尊", "菩薩", "明王", "如來", "金剛", "度母"]


@dataclass
class SacredEntity:
    cn: str
    en: str
    category: str
    source_url: str
    source_type: str = "tbsn_faxiang"
    aliases: List[str] = None
    mishears: List[str] = None
    keywords: List[str] = None
    weight: int = 3


@dataclass
class RitualTerm:
    cn: str
    en: str
    category: str
    source_url: str
    source_type: str = "tbsn_ritual"
    weight: int = 3


@dataclass
class PhraseMemory:
    source_lang: str
    target_lang: str
    cn: str
    en: str
    event_mode: str
    source_url: str
    source_type: str = "tbsn_phrase"
    weight: int = 3


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def fetch_html(url: str) -> BeautifulSoup:
    resp = SESSION.get(url, timeout=30)
    resp.raise_for_status()
    return BeautifulSoup(resp.text, "html.parser")


def extract_links(soup: BeautifulSoup):
    links = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        text = clean_text(a.get_text(" ", strip=True))
        if href and text:
            links.append((text, href))
    return links


def infer_category_from_text(text: str) -> str:
    if "菩薩" in text:
        return "bodhisattva"
    if "明王" in text or "金剛" in text:
        return "vidyaraja"
    if "佛母" in text:
        return "buddha-mother"
    if "度母" in text:
        return "tara"
    if "護法" in text:
        return "protector"
    if "祖師" in text:
        return "patriarch"
    if "財神" in text:
        return "wealth-deity"
    if "佛" in text or "如來" in text:
        return "buddha"
    return "other"


def extract_meta_title(soup: BeautifulSoup) -> str:
    meta = soup.find("meta", attrs={"property": "og:title"})
    if meta and meta.get("content"):
        return clean_text(meta["content"])
    if soup.title:
        return clean_text(soup.title.get_text(" ", strip=True))
    return ""


def extract_english_name(soup: BeautifulSoup, fallback_cn: str) -> str:
    title = extract_meta_title(soup)
    if title:
        m = re.search(r"\(([^)]+)\)", title)
        if m:
            return clean_text(m.group(1))

    page_text = clean_text(soup.get_text(" ", strip=True))
    english_candidates = re.findall(r"\b[A-Z][A-Za-z\- ]{3,}\b", page_text)
    for cand in english_candidates[:10]:
        c = clean_text(cand)
        if len(c.split()) <= 5:
            return c

    return fallback_cn


def extract_keywords(page_text: str) -> List[str]:
    picks = []
    for token in ["護摩", "灌頂", "咒", "印", "觀想", "本尊", "護法", "菩薩", "如來", "佛母", "度母", "明王"]:
        if token in page_text:
            picks.append(token)
    return picks


def looks_like_deity_name(text: str) -> bool:
    if len(text) < 2 or len(text) > 16:
        return False
    if text in CATEGORY_NAMES:
        return False
    return any(ch in text for ch in KEY_CHARS)


def ingest_faxiang_links() -> List[tuple]:
    soup = fetch_html(BASE_URL)
    links = extract_links(soup)

    deity_links = []
    seen: Set[str] = set()

    for text, href in links:
        full = urljoin(BASE_URL, href)

        if "tbsn.org" not in full:
            continue

        if looks_like_deity_name(text):
            key = f"{text}|{full}"
            if key not in seen:
                seen.add(key)
                deity_links.append((text, full))

    return deity_links


def ingest_entity_page(cn_name: str, url: str) -> SacredEntity:
    soup = fetch_html(url)
    page_text = clean_text(soup.get_text(" ", strip=True))
    category = infer_category_from_text(page_text or cn_name)
    en = extract_english_name(soup, cn_name)

    return SacredEntity(
        cn=cn_name,
        en=en,
        category=category,
        source_url=url,
        aliases=[],
        mishears=[],
        keywords=extract_keywords(page_text),
        weight=4,
    )


def ingest_ritual_terms_from_homepage() -> List[RitualTerm]:
    soup = fetch_html(BASE_URL)
    links = extract_links(soup)

    out = []
    ritual_seed_terms = {
        "真佛儀軌": ("True Buddha Ritual Manual", "ritual"),
        "灌頂類別": ("Empowerment Categories", "ritual"),
        "密法百問": ("One Hundred Questions on Vajrayana Practice", "teaching"),
        "入門手冊": ("Beginner's Handbook", "teaching"),
        "經藏部": ("Sutra Collection", "scripture"),
        "戒律部": ("Vinaya Collection", "scripture"),
    }

    for text, href in links:
        if text in ritual_seed_terms:
            en, category = ritual_seed_terms[text]
            out.append(
                RitualTerm(
                    cn=text,
                    en=en,
                    category=category,
                    source_url=urljoin(BASE_URL, href),
                    weight=4,
                )
            )

    return out


def build_seed_phrase_memory() -> List[PhraseMemory]:
    return [
        PhraseMemory(
            source_lang="zh",
            target_lang="en",
            cn="現在開始護摩法會",
            en="We will now begin the Homa Fire Offering Ceremony.",
            event_mode="Homa",
            source_url=BASE_URL,
            weight=4,
        ),
        PhraseMemory(
            source_lang="zh",
            target_lang="en",
            cn="請大家合掌",
            en="Please put your palms together.",
            event_mode="General",
            source_url=BASE_URL,
            weight=4,
        ),
        PhraseMemory(
            source_lang="zh",
            target_lang="en",
            cn="一心敬禮根本傳承上師",
            en="Wholeheartedly pay homage to the Root Lineage Guru.",
            event_mode="Liturgy",
            source_url=BASE_URL,
            weight=4,
        ),
    ]


def write_json(path: Path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    print("Fetching TBSN homepage...")
    deity_links = ingest_faxiang_links()
    print(f"Found {len(deity_links)} possible deity/entity links")

    entities = []
    for idx, (cn_name, url) in enumerate(deity_links, start=1):
        try:
            entity = ingest_entity_page(cn_name, url)
            entities.append(asdict(entity))
            print(f"[{idx}/{len(deity_links)}] {cn_name}")
            time.sleep(0.4)
        except Exception as e:
            print(f"FAILED {cn_name}: {e}")

    ritual_terms = [asdict(x) for x in ingest_ritual_terms_from_homepage()]
    phrase_memory = [asdict(x) for x in build_seed_phrase_memory()]

    multilingual_map = []
    for row in entities:
        multilingual_map.append(
            {
                "cn": row["cn"],
                "en": row["en"],
                "id": row["en"],
            }
        )

    write_json(OUT_DIR / "tbsn_sacred_entities.json", entities)
    write_json(OUT_DIR / "tbsn_ritual_terms.json", ritual_terms)
    write_json(OUT_DIR / "tbsn_phrase_memory.json", phrase_memory)
    write_json(OUT_DIR / "tbsn_multilingual_map.json", multilingual_map)

    print(f"Saved {len(entities)} sacred entities")
    print(f"Saved {len(ritual_terms)} ritual terms")
    print(f"Saved {len(phrase_memory)} phrase rows")
    print("Done.")


if __name__ == "__main__":
    main()