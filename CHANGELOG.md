# CHANGELOG

Project changes, newest first.

---

## 2026-10-30 — Add two gratitude books to Readalong (EPUB + audiobook)

- **Project:** readalong
- **Layman:** Added two new library books: a practical, science-backed guide
  called *Gratitude* and a Scripture-rooted companion called *Gratitude with
  Jesus*. Each one is a 10-chapter EPUB with a full audiobook narrated by the
  natural-sounding Microsoft neural voice Andrew, plus per-chapter MP3s and
  read-along timings.
- **Technical:** Added `source/gratitude.json` and
  `source/gratitude-with-jesus.json` (10 chapters each). Built
  `books/gratitude/` and `books/gratitude-with-jesus/` with `book.epub`,
  `audiobook.mp3`, `audio/chNN.mp3`, and `book.json`; regenerated
  `books/catalog.json`. Updated `build.py`: edge-tts 7.3.1's default synthesis
  host now works, so the stale forced `api.msedgeservices.com` endpoint (which
  returned 403) is only applied when `READALONG_TTS_WSS_URL` is set; paragraph
  clips are now synthesized concurrently with `asyncio.gather` instead of
  serially, cutting per-book narration time substantially.
- **Verification:** EPUB paragraphs match source JSON exactly; 10 chapters and
  correct element counts per chapter; `ffprobe` confirms mono 24 kHz 64 kbps
  MP3; full audiobook durations are 16.9 min (*Gratitude*) and 16.5 min
  (*Gratitude with Jesus*); both MP3s decode cleanly. Both books appear in
  `books/catalog.json`.
