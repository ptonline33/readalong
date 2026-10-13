/* Readalong: library + EPUB reader with synced audiobook playback.
 *
 * Data layout (produced by build.py):
 *   books/catalog.json            list of books for the library
 *   books/<id>/book.epub          reading copy
 *   books/<id>/book.json          metadata + audio chapters + paragraph timings
 *   books/<id>/audio/chNN.mp3     narration per chapter
 */
(() => {
  "use strict";

  const PROGRESS_KEY = (id) => `readalong:progress:${id}`;
  const SPEED_KEY = "readalong:speed";
  const SIZE_KEY = "readalong:textSize";
  const SIZES = [1.3, 1.45, 1.6, 1.75, 1.9, 2.1, 2.3]; // rem (html root is 18px)
  const DEFAULT_SIZE_INDEX = 2; // 1.6rem = 28.8px, up from 23.4px

  const $ = (sel) => document.querySelector(sel);
  const els = {
    library: $("#libraryView"),
    grid: $("#bookGrid"),
    reader: $("#readerView"),
    title: $("#bookTitle"),
    chapterSelect: $("#chapterSelect"),
    text: $("#text"),
    error: $("#readerError"),
    player: $("#player"),
    audio: $("#audio"),
    play: $("#playBtn"),
    back: $("#back15"),
    fwd: $("#fwd15"),
    prev: $("#prevCh"),
    next: $("#nextCh"),
    seek: $("#seek"),
    cur: $("#curTime"),
    tot: $("#totTime"),
    speed: $("#speed"),
    now: $("#nowPlaying"),
    home: $("#homeBtn"),
    sizeControls: $("#sizeControls"),
    smaller: $("#smallerBtn"),
    bigger: $("#biggerBtn"),
    downloads: $("#downloads"),
    dlEpub: $("#dlEpub"),
    dlAudiobook: $("#dlAudiobook"),
    dlChapters: $("#dlChapters"),
    toast: $("#toast"),
    font: $("#fontSelect"),
    theme: $("#themeSelect"),
  };

  const THEME_KEY = "readalong:theme";
  const THEMES = ["night", "sepia", "light", "contrast"];

  function applyTheme(key) {
    const theme = THEMES.includes(key) ? key : "night";
    document.documentElement.dataset.readTheme = theme;
    els.theme.value = theme;
    localStorage.setItem(THEME_KEY, theme);
  }

  const FONT_KEY = "readalong:font";
  const FONTS = {
    atkinson: '"Atkinson Hyperlegible", Arial, sans-serif',
    opendyslexic: '"OpenDyslexic", Arial, sans-serif',
    lexend: '"Lexend", Arial, sans-serif',
    literata: '"Literata", Georgia, serif',
    lora: '"Lora", Georgia, serif',
    dancing: '"Dancing Script", cursive',
  };

  function applyFont(key) {
    const family = FONTS[key] ? key : "atkinson";
    document.documentElement.style.setProperty("--reader-font", FONTS[family]);
    els.font.value = family;
    localStorage.setItem(FONT_KEY, family);
  }


  const state = {
    catalog: null,
    book: null,        // book.json
    bookBase: "",      // e.g. "books/how-the-body-works/"
    chapters: [],      // parsed EPUB: [{title, blocks:[{tag,text}]}]
    chapterIndex: 0,
    activeBlock: -1,
    lastSave: 0,
    sizeIndex: DEFAULT_SIZE_INDEX,
  };

  /* ---------- helpers ---------- */

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
  }

  function fmtLong(sec) {
    const mins = Math.round(sec / 60);
    return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  }

  function readProgress(id) {
    try {
      return JSON.parse(localStorage.getItem(PROGRESS_KEY(id))) || null;
    } catch {
      return null;
    }
  }

  function saveProgress(force = false) {
    if (!state.book) return;
    const now = Date.now();
    if (!force && now - state.lastSave < 2500) return;
    state.lastSave = now;
    localStorage.setItem(
      PROGRESS_KEY(state.book.id),
      JSON.stringify({ chapter: state.chapterIndex, time: els.audio.currentTime || 0 })
    );
  }

  function setAccent(color) {
    document.documentElement.style.setProperty("--accent", color);
    document.documentElement.style.setProperty("--accent-2", color);
    document.documentElement.style.setProperty("--glow", color);
  }

  function showView(name) {
    els.library.hidden = name !== "library";
    els.reader.hidden = name !== "reader";
    els.player.hidden = name !== "reader";
    els.home.hidden = name !== "reader";
    els.sizeControls.hidden = name !== "reader";
    document.body.classList.toggle("reading", name === "reader");
  }

  /* ---------- EPUB parsing ---------- */

  async function parseEpub(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const containerXml = await zip.file("META-INF/container.xml").async("string");
    const parser = new DOMParser();
    const container = parser.parseFromString(containerXml, "application/xml");
    const opfPath = container.querySelector("rootfile").getAttribute("full-path");
    const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

    const opf = parser.parseFromString(await zip.file(opfPath).async("string"), "application/xml");
    const manifest = new Map();
    opf.querySelectorAll("manifest > item").forEach((item) => {
      manifest.set(item.getAttribute("id"), {
        href: item.getAttribute("href"),
        props: item.getAttribute("properties") || "",
      });
    });

    const chapters = [];
    for (const ref of opf.querySelectorAll("spine > itemref")) {
      const item = manifest.get(ref.getAttribute("idref"));
      if (!item || item.props.includes("nav")) continue;
      const file = zip.file(opfDir + item.href);
      if (!file) continue;

      const doc = parser.parseFromString(await file.async("string"), "text/html");
      const blocks = [...doc.body.querySelectorAll("h1, h2, h3, p")]
        .map((node) => ({
          tag: node.tagName.toLowerCase(),
          text: node.textContent.replace(/\s+/g, " ").trim(),
        }))
        .filter((b) => b.text);
      const heading = blocks.find((b) => /^h\d$/.test(b.tag));
      chapters.push({ title: heading ? heading.text : `Chapter ${chapters.length + 1}`, blocks });
    }
    return chapters;
  }

  /* ---------- library ---------- */

  async function loadCatalog() {
    if (state.catalog) return state.catalog;
    const res = await fetch("books/catalog.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("Could not load the library.");
    state.catalog = (await res.json()).books;
    return state.catalog;
  }

  function renderLibrary(books) {
    els.grid.textContent = "";
    if (!books.length) {
      els.grid.innerHTML = '<p class="muted">No books yet. Run build.py to add one.</p>';
      return;
    }
    for (const book of books) {
      const card = document.createElement("article");
      card.className = "card";
      card.tabIndex = 0;
      card.style.setProperty("--glow", book.color);

      const cover = document.createElement("div");
      cover.className = "cover";
      cover.style.setProperty("--c1", book.color);
      cover.style.setProperty("--c2", "#1b1140");
      const h3 = document.createElement("h3");
      h3.textContent = book.title;
      cover.append(h3);

      const body = document.createElement("div");
      body.className = "card-body";
      const sub = document.createElement("p");
      sub.textContent = book.subtitle || "";
      const desc = document.createElement("p");
      desc.textContent = book.description || "";
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${book.chapters} chapters \u00b7 ${fmtLong(book.duration)} of audio`;
      body.append(sub, desc, meta);

      const progress = readProgress(book.id);
      if (progress && progress.time > 5) {
        const resume = document.createElement("div");
        resume.className = "resume";
        resume.textContent = `Resume: chapter ${progress.chapter + 1} at ${fmt(progress.time)}`;
        body.append(resume);
      }

      const go = document.createElement("button");
      go.className = "go";
      go.type = "button";
      go.textContent = "Read & listen";
      body.append(go);

      card.append(cover, body);
      const open = () => { location.hash = `#/read/${encodeURIComponent(book.id)}`; };
      card.addEventListener("click", open);
      card.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
      go.addEventListener("click", (e) => { e.stopPropagation(); open(); });
      els.grid.append(card);
    }
  }

  /* ---------- reader ---------- */

  async function openBook(id) {
    showView("reader");
    els.error.hidden = true;
    els.title.textContent = "Loading\u2026";
    els.text.textContent = "";
    els.now.textContent = "";
    stopPlayback();

    try {
      const catalog = await loadCatalog();
      const entry = catalog.find((b) => b.id === id);
      if (!entry) throw new Error("That book is not in the library.");

      state.bookBase = entry.path;
      const [book, epubBuf] = await Promise.all([
        fetch(`${entry.path}book.json`, { cache: "no-cache" }).then((r) => {
          if (!r.ok) throw new Error("Missing book.json");
          return r.json();
        }),
        fetch(`${entry.path}book.epub`).then((r) => {
          if (!r.ok) throw new Error("Missing EPUB file");
          return r.arrayBuffer();
        }),
      ]);
      state.book = book;
      state.chapters = await parseEpub(epubBuf);
      setAccent(book.color);
      setDownloadLinks(entry.path, book);

      document.title = `${book.title} \u00b7 Readalong`;
      els.title.textContent = book.title;

      els.chapterSelect.textContent = "";
      book.chapters.forEach((ch, i) => {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = `${i + 1}. ${ch.title}`;
        els.chapterSelect.append(opt);
      });

      const saved = readProgress(id);
      const startChapter = saved && saved.chapter < book.chapters.length ? saved.chapter : 0;
      loadChapter(startChapter, saved && saved.chapter === startChapter ? saved.time : 0, false);
      els.audio.playbackRate = Number(els.speed.value);
    } catch (err) {
      console.error(err);
      els.title.textContent = "Could not open this book";
      els.error.textContent = err.message || String(err);
      els.error.hidden = false;
    }
  }

  function setDownloadLinks(base, book) {
    const safe = (s) => s.replace(/[\\/:*?"<>|]+/g, "").trim();
    els.dlEpub.href = base + book.epub;
    els.dlEpub.download = `${safe(book.title)}.epub`;

    if (book.audiobook) {
      els.dlAudiobook.hidden = false;
      els.dlAudiobook.href = base + book.audiobook.file;
      els.dlAudiobook.download = `${safe(book.title)} (audiobook).mp3`;
    } else {
      els.dlAudiobook.hidden = true;
    }

    els.dlChapters.textContent = "";
    book.chapters.forEach((ch, i) => {
      const a = document.createElement("a");
      a.className = "menu-item";
      a.href = base + ch.audio;
      a.download = `${String(i + 1).padStart(2, "0")} ${safe(ch.title)}.mp3`;
      a.textContent = `${i + 1}. ${ch.title}`;
      a.addEventListener("click", () => { els.downloads.open = false; });
      els.dlChapters.append(a);
    });
    for (const a of [els.dlEpub, els.dlAudiobook]) {
      a.addEventListener("click", () => { els.downloads.open = false; });
    }
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { els.toast.hidden = true; }, 3500);
  }

  function updatePageNav() {
    const total = state.book ? state.book.chapters.length : 0;
    const i = state.chapterIndex;
    document.querySelectorAll('[data-page="prev"]').forEach((b) => { b.disabled = i <= 0; });
    document.querySelectorAll('[data-page="next"]').forEach((b) => { b.disabled = i >= total - 1; });
    document.querySelectorAll("[data-page-label]").forEach((l) => {
      l.textContent = total ? `Chapter ${i + 1} of ${total}` : "";
    });
  }

  function loadChapter(index, startTime = 0, autoplay = false) {
    const book = state.book;
    if (!book || index < 0 || index >= book.chapters.length) return;
    state.chapterIndex = index;
    state.activeBlock = -1;

    const chapter = book.chapters[index];
    const parsed = state.chapters[index];
    renderText(parsed);
    els.chapterSelect.value = String(index);
    updatePageNav();

    els.audio.src = state.bookBase + chapter.audio;
    els.audio.load();
    els.audio.addEventListener("loadedmetadata", function onMeta() {
      els.audio.removeEventListener("loadedmetadata", onMeta);
      if (startTime > 0 && startTime < els.audio.duration) els.audio.currentTime = startTime;
      els.seek.max = String(els.audio.duration || chapter.duration);
      els.tot.textContent = fmt(els.audio.duration || chapter.duration);
      syncHighlight();
    });

    els.now.textContent = `${index + 1}. ${chapter.title}`;
    setMediaSession(chapter);
    if (autoplay) play();
    saveProgress(true);
  }

  function renderText(parsed) {
    els.text.textContent = "";
    if (!parsed) return;
    parsed.blocks.forEach((block, i) => {
      const node = document.createElement(block.tag === "p" ? "p" : "h1");
      node.className = block.tag === "p" ? "block" : "block heading";
      node.dataset.i = String(i);
      node.textContent = block.text;
      node.addEventListener("click", () => seekToBlock(i, true));
      els.text.append(node);
    });
    window.scrollTo(0, 0);
  }

  function currentElements() {
    const chapter = state.book && state.book.chapters[state.chapterIndex];
    return chapter ? chapter.elements : [];
  }

  function seekToBlock(i, startPlaying) {
    const el = currentElements()[i];
    if (!el) return;
    els.audio.currentTime = el.start;
    if (startPlaying) play();
    syncHighlight();
  }

  function syncHighlight() {
    const t = els.audio.currentTime || 0;
    const elements = currentElements();
    let idx = -1;
    for (let k = 0; k < elements.length; k++) {
      if (elements[k].start <= t + 0.05) idx = k;
      else break;
    }
    if (idx === state.activeBlock) return;
    state.activeBlock = idx;

    const nodes = els.text.querySelectorAll(".block");
    nodes.forEach((n) => n.classList.remove("active"));
    if (idx >= 0) {
      const node = els.text.querySelector(`.block[data-i="${idx}"]`);
      if (node) {
        node.classList.add("active");
        if (!els.audio.paused) {
          node.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }
    }
  }

  /* ---------- playback ---------- */

  function play() {
    const p = els.audio.play();
    if (p && p.catch) p.catch((e) => console.warn("Playback blocked:", e));
  }

  function stopPlayback() {
    els.audio.pause();
    els.audio.removeAttribute("src");
    els.audio.load();
  }

  function togglePlay() {
    if (!state.book) return;
    if (els.audio.paused) play();
    else els.audio.pause();
  }

  function skip(seconds) {
    if (!state.book) return;
    const max = els.audio.duration || 0;
    els.audio.currentTime = Math.max(0, Math.min(max, els.audio.currentTime + seconds));
  }

  function setMediaSession(chapter) {
    if (!("mediaSession" in navigator) || !state.book) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: chapter.title,
      artist: state.book.narrator || state.book.author,
      album: state.book.title,
    });
    const handlers = {
      play: () => play(),
      pause: () => els.audio.pause(),
      seekbackward: () => skip(-15),
      seekforward: () => skip(15),
      previoustrack: () => loadChapter(state.chapterIndex - 1, 0, !els.audio.paused),
      nexttrack: () => loadChapter(state.chapterIndex + 1, 0, !els.audio.paused),
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported */ }
    }
  }

  /* ---------- wiring ---------- */

  function bindPlayer() {
    els.home.addEventListener("click", () => { location.hash = "#/"; });

    document.querySelectorAll("[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const step = btn.dataset.page === "next" ? 1 : -1;
        loadChapter(state.chapterIndex + step, 0, !els.audio.paused);
      });
    });

    els.play.addEventListener("click", togglePlay);
    els.back.addEventListener("click", () => skip(-15));
    els.fwd.addEventListener("click", () => skip(15));
    els.prev.addEventListener("click", () => loadChapter(state.chapterIndex - 1, 0, !els.audio.paused));
    els.next.addEventListener("click", () => loadChapter(state.chapterIndex + 1, 0, !els.audio.paused));

    els.chapterSelect.addEventListener("change", () => {
      loadChapter(Number(els.chapterSelect.value), 0, !els.audio.paused);
    });

    els.seek.addEventListener("input", () => {
      els.audio.currentTime = Number(els.seek.value);
    });

    els.speed.value = localStorage.getItem(SPEED_KEY) || "1";
    els.speed.addEventListener("change", () => {
      els.audio.playbackRate = Number(els.speed.value);
      localStorage.setItem(SPEED_KEY, els.speed.value);
    });

    els.audio.addEventListener("play", () => {
      els.play.textContent = "Pause";
      els.play.setAttribute("aria-label", "Pause");
    });
    els.audio.addEventListener("pause", () => {
      els.play.textContent = "Play";
      els.play.setAttribute("aria-label", "Play");
      saveProgress(true);
    });
    els.audio.addEventListener("timeupdate", () => {
      const t = els.audio.currentTime;
      els.cur.textContent = fmt(t);
      if (document.activeElement !== els.seek) {
        els.seek.value = String(t);
      }
      syncHighlight();
      saveProgress();
    });
    els.font.addEventListener("change", () => applyFont(els.font.value));
    applyFont(localStorage.getItem(FONT_KEY) || "atkinson");
    els.theme.addEventListener("change", () => applyTheme(els.theme.value));
    applyTheme(localStorage.getItem(THEME_KEY) || "night");

    els.audio.addEventListener("ended", () => {
      const next = state.chapterIndex + 1;
      if (state.book && next < state.book.chapters.length) {
        loadChapter(next, 0, true);
      } else {
        els.play.textContent = "Play";
      }
    });

    const setSize = (i) => {
      state.sizeIndex = Math.max(0, Math.min(SIZES.length - 1, i));
      document.documentElement.style.setProperty("--reader-size", `${SIZES[state.sizeIndex]}rem`);
      localStorage.setItem(SIZE_KEY, String(state.sizeIndex));
    };
    els.smaller.addEventListener("click", () => setSize(state.sizeIndex - 1));
    els.bigger.addEventListener("click", () => setSize(state.sizeIndex + 1));
    setSize(Number(localStorage.getItem(SIZE_KEY) ?? DEFAULT_SIZE_INDEX));

    window.addEventListener("pagehide", () => saveProgress(true));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") saveProgress(true);
    });

    document.addEventListener("keydown", (e) => {
      if (els.reader.hidden || e.target.closest("select, input, button")) return;
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      if (e.key === "ArrowLeft") skip(-15);
      if (e.key === "ArrowRight") skip(15);
    });
  }

  async function route() {
    const match = location.hash.match(/^#\/read\/(.+)$/);
    if (match) {
      openBook(decodeURIComponent(match[1]));
      return;
    }
    showView("library");
    document.title = "Readalong";
    stopPlayback();
    state.book = null;
    try {
      renderLibrary(await loadCatalog());
    } catch (err) {
      els.grid.innerHTML = "";
      const p = document.createElement("p");
      p.className = "error";
      p.textContent = err.message;
      els.grid.append(p);
    }
  }

  function init() {
    bindPlayer();
    document.addEventListener("click", (e) => {
      document.querySelectorAll("details.menu[open]").forEach((menu) => {
        if (!menu.contains(e.target)) menu.open = false;
      });
    });
    window.addEventListener("hashchange", route);
    route();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW failed", err));
    }
  }

  init();
})();
