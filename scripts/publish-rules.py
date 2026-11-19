"""Build a Chinese KIWI rules pack from a single released CommunityDragon patch."""
import argparse
import hashlib
import html
import json
import math
import os
from pathlib import Path
import re
from datetime import datetime, timezone
from urllib.request import Request, urlopen

import xxhash

LIMIT = 64 * 1024 * 1024


def download(root, name):
    request = Request(f"{root}/{name}", headers={"User-Agent": "HexGuide-rules/1.0"})
    with urlopen(request, timeout=35) as response:
        body = response.read(LIMIT + 1)
    if len(body) > LIMIT:
        raise ValueError(f"Asset exceeds size limit: {name}")
    return json.loads(body)


def make_pack(patch, lists, definitions, english, chinese, strings):
    paths = next(row["augmentList"] for row in lists if row["modeName"] == "KIWI")
    pool = {p.rsplit("/", 1)[-1].lower(): p for p in paths}
    rows = [r for r in definitions.values() if isinstance(r, dict) and r.get("__type") == "AugmentData"]
    if not 100 <= len(paths) <= 1024 or len(paths) != len(pool) or len(rows) != len(pool):
        raise ValueError("Incomplete KIWI pool")
    english = {row["id"]: row for row in english}
    chinese = {row["id"]: row for row in chinese}
    entries = strings["entries"]

    def localized(key, seen=()):
        if not key or key in seen or len(seen) >= 8:
            return None
        key = key.lower()
        digest = xxhash.xxh3_64_intdigest(key.encode()) & ((1 << 38) - 1)
        value = entries.get(key, entries.get(f"{{{digest:010x}}}"))
        if value is None:
            return None
        return re.sub(r"\{\{([^{}]+)\}\}", lambda m: localized(m[1], (*seen, key)) or m[0], value)

    result = []
    seen_ids = set()
    for row in rows:
        numeric = row["AugmentPlatformId"]
        game_id = row["AugmentNameId"]
        source = pool.pop(game_id.lower())
        if numeric in seen_ids or english[numeric]["augmentNameId"] != game_id or chinese[numeric]["augmentNameId"] != game_id:
            raise ValueError(f"Conflicting identity: {game_id}")
        seen_ids.add(numeric)
        raw = localized(row.get("DescriptionTra"))
        name = localized(row.get("NameTra")) or chinese[numeric].get("nameTRA", "")
        internal = game_id == "GoH_PentakillAug_Generic"
        if raw is None or (not internal and not name) or "\ufffd" in name + raw:
            raise ValueError(f"Incomplete localization: {game_id}")
        constants = {}
        spell = definitions.get(row.get("RootSpell"), {}).get("mSpell", {})
        for value in spell.get("DataValues", []):
            levels = value.get("values", [])
            if levels and all(isinstance(n, (int, float)) and math.isfinite(n) and n == levels[0] for n in levels):
                constants[value["name"].lower()] = levels[0]

        def substitute(match):
            constant = constants.get(match[1].lower())
            if constant is None:
                return match[0]
            return format(round(constant * float(match[2] or 1), 4), ".12g")

        text = re.sub(r"@([a-zA-Z0-9_]+)(?:\*([0-9.]+))?@", substitute, raw)
        text = re.sub(r"(?i)<br\s*/?>|\[br/?\]", "\n", text)
        text = html.unescape(re.sub(r"<[^>]*>|%i:[^%]+%|\[/?(?:stat(?::[^\]]+)?|b|i)\]", "", text))
        text = re.sub(r"\n\s*", "\n", re.sub(r"[ \t\r]+", " ", text)).strip()
        unresolved = list(dict.fromkeys(re.findall(r"@[^@\n]+@|\{\{[^{}]+\}\}", text)))
        text = re.sub(r"@[^@\n]+@", "〔数值待核实〕", text)
        text = re.sub(r"\{\{[^{}]+\}\}", "〔运行时内容待核实〕", text)
        icon = row["AugmentSmallIconPath"].lower()
        if not re.fullmatch(r"assets/[\w./-]+\.tex", icon) or ".." in icon:
            raise ValueError(f"Invalid icon path: {game_id}")
        result.append(dict(gameDataId=numeric, sourceGameId=game_id, sourcePath=source,
                           name=name, enName=english[numeric]["nameTRA"], description=text,
                           rarity=("silver", "gold", "prismatic")[row.get("rarity", 0)],
                           iconPath=icon[:-4]+".png", unresolvedValues=unresolved))
    return {"schemaVersion": 1, "clientPatch": patch, "augments": sorted(result, key=lambda row: row["gameDataId"])}


def publish(publisher):
    notices = json.loads((publisher / "announcements/index-v3.json").read_bytes())
    official = [r for r in notices["entries"] if r.get("format") == 2]
    major, minor = max(tuple(map(int, r["toVersion"].split(".")[:2])) for r in official)
    patch = f"{major}.{minor}"
    current = [r for r in official if r["toVersion"].startswith(patch + ".")]
    patch_title = f"{major + 10}.{minor} 官网更新公告"
    patch_notice = next((r for r in current if r["title"].startswith(patch_title)
                         and re.fullmatch(r"https://lol\.qq\.com/gicp/news/\d+/\d+\.html",
                                          r.get("sourceUrl") or "")), None)
    if not patch_notice:
        raise ValueError(f"Missing official patch notice for {patch}")
    facts = sorted((r["id"], r["sha256"]) for r in current)
    announcement_revision = hashlib.sha256(json.dumps(facts).encode()).hexdigest()
    directory = publisher / "rules"
    directory.mkdir(exist_ok=True)
    index = directory / "index.json"
    prior = json.loads(index.read_bytes()) if index.exists() else {}
    if prior:
        existing = directory / (prior["sha256"] + ".json")
        if hashlib.sha256(existing.read_bytes()).hexdigest() != prior["sha256"]:
            raise ValueError("Published rules digest mismatch")
        prior_patch = tuple(map(int, prior["clientPatch"].split(".")))
        if prior_patch > (major, minor) or (prior_patch == (major, minor)
                and prior.get("announcementRevision") == announcement_revision):
            return
    base = f"https://raw.communitydragon.org/{patch}"
    client = "plugins/rcp-be-lol-game-data/global/"
    pack = make_pack(patch, download(base, client+"default/v1/augment-lists.json"),
                     download(base, "game/maps/modespecificdata/kiwi.bin.json"),
                     download(base, client+"default/v1/cherry-augments.json"),
                     download(base, client+"zh_cn/v1/cherry-augments.json"),
                     download(base, "game/zh_cn/data/menu/en_us/lol.stringtable.json"))
    pack["officialAnnouncement"] = {"version": patch_notice["toVersion"], "url": patch_notice["sourceUrl"]}
    body = json.dumps(pack, ensure_ascii=False, separators=(",", ":")).encode()
    digest = hashlib.sha256(body).hexdigest()
    updated_at = prior.get("updatedAt")
    if digest != prior.get("sha256"):
        (directory / (digest + ".json")).write_bytes(body)
        updated_at = datetime.now(timezone.utc).isoformat()
    manifest = dict(schemaVersion=1, clientPatch=patch, sha256=digest, updatedAt=updated_at,
                    announcementRevision=announcement_revision)
    temp = directory / "index.tmp"
    temp.write_text(json.dumps(manifest, indent=2)+"\n", encoding="utf-8")
    os.replace(temp, index)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("publisher", type=Path)
    publish(parser.parse_args().publisher)
