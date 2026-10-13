#!/usr/bin/env python3
"""Build Readalong books from source/*.json.

For each source file this produces, under books/<id>/:
  book.epub          - the reading copy (EPUB 3)
  audio/chapNN.mp3   - Andrew narration, one file per chapter
  book.json          - metadata + per-element audio timings used for read-along

and regenerates books/catalog.json, which the app reads to build the library.

Usage (from the project folder):
  .venv/bin/python build.py                 # build every source/*.json
  .venv/bin/python build.py source/foo.json # build one book
  .venv/bin/python build.py --combine-only  # add audiobook.mp3 to existing books, no re-narration

To add a book later: write source/<id>.json (see the existing files for the
shape: id, title, subtitle, author, color, description, chapters[{title,
paragraphs[]}]) and run the command above. Needs ffmpeg/ffprobe on PATH.
"""
import asyncio
import html
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import edge_tts
import edge_tts.communicate as edge_comm
from ebooklib import epub

ROOT = Path(__file__).resolve().parent
SOURCE_DIR = ROOT / "source"
BOOKS_DIR = ROOT / "books"

VOICE = "en-US-AndrewNeural"   # Microsoft neural male voice
RATE = "-5%"                   # slightly slower, easier to follow
GAP_SECONDS = 0.6              # pause between paragraphs

# Since Oct 2026 the old speech.platform.bing.com synthesis host returns 403
# for many clients. The same neural voices are served from
# api.msedgeservices.com, which takes the token as Ocp-Apim-Subscription-Key.
# Point edge-tts at that host. Without this, every synthesis call fails.
edge_comm.WSS_URL = (
    "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1"
    f"?Ocp-Apim-Subscription-Key={edge_tts.constants.TRUSTED_CLIENT_TOKEN}"
)
edge_comm.SEC_MS_GEC_VERSION = "1-143.0.3650.75"

EPUB_CSS = """
body { font-family: "Atkinson Hyperlegible", Arial, sans-serif; line-height: 1.7; font-size: 1.1em; }
h1 { font-size: 1.6em; margin-bottom: 0.8em; }
p { margin: 0 0 1em 0; }
"""


def esc(text):
    return html.escape(text, quote=True)


def media_duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout
    return float(out.strip())


async def synthesize(text, path):
    """Narrate one piece of text with Andrew, retrying on transient failures."""
    last_error = None
    for attempt in range(1, 4):
        try:
            await edge_tts.Communicate(text, VOICE, rate=RATE).save(str(path))
            if path.exists() and path.stat().st_size > 0:
                return
        except Exception as exc:  # network / service hiccup
            last_error = exc
        await asyncio.sleep(2 * attempt)
    raise RuntimeError(f"TTS failed for {path.name}: {last_error}")


def build_chapter_audio(index, chapter, out_mp3, tmp):
    """Narrate heading + paragraphs, join with gaps, return (elements, duration).

    elements[0] is the chapter heading, elements[1..] are the paragraphs, in
    the same order the EPUB chapter lists them, so the app can line them up.
    """
    texts = [f"Chapter {index + 1}. {chapter['title']}."] + list(chapter["paragraphs"])

    silence = tmp / "silence.mp3"
    if not silence.exists():
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
             "anullsrc=r=24000:cl=mono", "-t", str(GAP_SECONDS),
             "-c:a", "libmp3lame", "-b:a", "48k", str(silence)],
            check=True,
        )

    clip_paths = []
    for i, text in enumerate(texts):
        clip = tmp / f"ch{index + 1:02d}-{i:03d}.mp3"
        asyncio.run(synthesize(text, clip))
        clip_paths.append(clip)

    # Measure each clip and lay out start/end times with the gaps between them.
    elements = []
    cursor = 0.0
    for clip in clip_paths:
        length = media_duration(clip)
        elements.append({"start": round(cursor, 3), "end": round(cursor + length, 3)})
        cursor += length + GAP_SECONDS

    # Join clips + silences into one chapter MP3.
    list_file = tmp / f"ch{index + 1:02d}-list.txt"
    lines = []
    for n, clip in enumerate(clip_paths):
        lines.append(f"file '{clip}'")
        if n < len(clip_paths) - 1:
            lines.append(f"file '{silence}'")
    list_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
         "-i", str(list_file), "-c:a", "libmp3lame", "-b:a", "64k",
         "-ar", "24000", "-ac", "1", str(out_mp3)],
        check=True,
    )
    return elements, media_duration(out_mp3)


def build_epub(meta, out_path):
    book = epub.EpubBook()
    book.set_identifier(f"readalong-{meta['id']}")
    book.set_title(meta["title"])
    book.set_language("en")
    book.add_author(meta.get("author", "Readalong"))

    style = epub.EpubItem(uid="style", file_name="style/main.css",
                          media_type="text/css", content=EPUB_CSS)
    book.add_item(style)

    chapters = []
    for index, chapter in enumerate(meta["chapters"]):
        body = f"<h1>{esc(chapter['title'])}</h1>" + "".join(
            f"<p>{esc(p)}</p>" for p in chapter["paragraphs"]
        )
        item = epub.EpubHtml(title=chapter["title"],
                             file_name=f"ch{index + 1:02d}.xhtml", lang="en")
        item.content = (
            "<html xmlns='http://www.w3.org/1999/xhtml'><head>"
            f"<title>{esc(chapter['title'])}</title>"
            "<link rel='stylesheet' href='style/main.css'/></head>"
            f"<body>{body}</body></html>"
        )
        item.add_item(style)
        book.add_item(item)
        chapters.append(item)

    book.toc = tuple(chapters)
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = chapters
    epub.write_epub(str(out_path), book)


def combine_audiobook(book_dir, book):
    """Join the chapter MP3s into one audiobook file (reuses existing narration)."""
    list_file = book_dir / "audio" / "_concat.txt"
    lines = [f"file '{(book_dir / ch['audio']).resolve()}'" for ch in book["chapters"]]
    list_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    out = book_dir / "audiobook.mp3"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
         "-i", str(list_file), "-c", "copy", str(out)],
        check=True,
    )
    list_file.unlink()
    book["audiobook"] = {"file": "audiobook.mp3", "duration": round(media_duration(out), 2)}
    return book


def build_book(source_path):
    meta = json.loads(source_path.read_text(encoding="utf-8"))
    book_id = meta["id"]
    out_dir = BOOKS_DIR / book_id
    audio_dir = out_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    print(f"[{book_id}] writing EPUB")
    build_epub(meta, out_dir / "book.epub")

    chapters_out = []
    total = 0.0
    tmp = Path(tempfile.mkdtemp(prefix=f"readalong-{book_id}-"))
    try:
        for index, chapter in enumerate(meta["chapters"]):
            print(f"[{book_id}] narrating chapter {index + 1}/{len(meta['chapters'])}: {chapter['title']}")
            name = f"ch{index + 1:02d}.mp3"
            elements, duration = build_chapter_audio(index, chapter, audio_dir / name, tmp)
            chapters_out.append({
                "title": chapter["title"],
                "audio": f"audio/{name}",
                "duration": round(duration, 2),
                "elements": elements,
            })
            total += duration
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    book = {
        "id": book_id,
        "title": meta["title"],
        "subtitle": meta.get("subtitle", ""),
        "author": meta.get("author", ""),
        "description": meta.get("description", ""),
        "color": meta.get("color", "#7b5cff"),
        "narrator": "Andrew (Microsoft neural voice)",
        "epub": "book.epub",
        "duration": round(total, 2),
        "chapters": chapters_out,
    }
    combine_audiobook(out_dir, book)
    (out_dir / "book.json").write_text(json.dumps(book, ensure_ascii=False, indent=2),
                                       encoding="utf-8")
    print(f"[{book_id}] done ({round(total / 60, 1)} min of audio)")
    return book


def write_catalog():
    entries = []
    for book_file in sorted(BOOKS_DIR.glob("*/book.json")):
        book = json.loads(book_file.read_text(encoding="utf-8"))
        entries.append({
            "id": book["id"],
            "title": book["title"],
            "subtitle": book["subtitle"],
            "author": book["author"],
            "description": book["description"],
            "color": book["color"],
            "duration": book["duration"],
            "chapters": len(book["chapters"]),
            "path": f"books/{book['id']}/",
        })
    (BOOKS_DIR / "catalog.json").write_text(json.dumps({"books": entries}, ensure_ascii=False, indent=2),
                                            encoding="utf-8")
    print(f"catalog: {len(entries)} book(s)")


def combine_existing():
    """Add audiobook.mp3 to books that were built before it existed, without re-narrating."""
    for book_file in sorted(BOOKS_DIR.glob("*/book.json")):
        book = json.loads(book_file.read_text(encoding="utf-8"))
        combine_audiobook(book_file.parent, book)
        book_file.write_text(json.dumps(book, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[{book['id']}] audiobook.mp3 written")
    write_catalog()


def main(argv):
    BOOKS_DIR.mkdir(exist_ok=True)
    if argv == ["--combine-only"]:
        combine_existing()
        return
    sources = [Path(a) for a in argv] if argv else sorted(SOURCE_DIR.glob("*.json"))
    if not sources:
        sys.exit("no source files found")
    for source in sources:
        build_book(source if source.is_absolute() else ROOT / source)
    write_catalog()


if __name__ == "__main__":
    main(sys.argv[1:])
