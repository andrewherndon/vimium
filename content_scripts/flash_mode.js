//
// Flash mode: an easymotion/flash-style select.
//
// The user types a word that's visible on screen; every match is highlighted and given a hint
// label. Pressing a label (or <Enter> for the first match) jumps there and enters Visual mode with
// the match selected. It's find, but scoped to the viewport, able to target several matches at
// once, and dropping straight into Visual mode. Reuses AlphabetHints for the labels and VisualMode
// for the selection.
//

// Collects literal matches of `query` in the text currently visible in the viewport, as
// `{ range, rect }`. Scans visible text nodes only, bounded by `max` matches and a node budget, so
// it's cheap to re-run per keystroke. Smart-case like find mode. A match must lie within a single
// text node (a query split across elements won't be found).
const collectFlashMatches = (query, max) => {
  const out = [];
  const root = document.body || document.documentElement;
  if (!query || !root) return out;

  const ignoreCase = query === query.toLowerCase();
  const fold = (s) => (ignoreCase ? s.toLowerCase() : s);
  const needle = fold(query);
  const needleLen = needle.length;
  const vw = globalThis.innerWidth;
  const vh = globalThis.innerHeight;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  let node;
  let budget = 20000; // upper bound on scanned nodes so a common short query can't freeze the page
  while ((node = walker.nextNode()) && out.length < max && budget-- > 0) {
    const data = node.data;
    if (data.length < needleLen) continue;
    const hay = fold(data);
    // cheap string test first: only do layout work for nodes that actually contain the text
    if (hay.indexOf(needle) < 0) continue;
    const parent = node.parentElement;
    if (!parent) continue;
    const tag = parent.nodeName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript") continue;
    // one layout read to skip a matching node whose element lies entirely outside the viewport
    const pr = parent.getBoundingClientRect();
    if (
      !pr.width || !pr.height || pr.bottom <= 0 || pr.right <= 0 || pr.top >= vh || pr.left >= vw
    ) {
      continue;
    }
    let from = 0;
    let idx;
    while (((idx = hay.indexOf(needle, from)) >= 0) && (out.length < max)) {
      from = idx + needleLen;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, from);
      const rect = range.getBoundingClientRect();
      if (
        rect.width && rect.height &&
        rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw
      ) {
        out.push({ range, rect });
      }
    }
  }
  return out;
};

class FlashMode {
  constructor(options) {
    if (options == null) options = {};
    this.options = options;
    this.maxMatches = options.max || 200;
    // Opt-in: jump straight into Visual mode as soon as a single match remains.
    this.autojump = options.autojump === true;

    this.query = "";
    this.labelSeq = ""; // the label characters typed so far (once the query stops matching)
    this.matches = [];
    this.markers = [];
    this.containerEl = null;

    this.mode = new Mode();
    this.mode.init({
      name: "flash",
      indicator: false,
      singleton: "flash-mode",
      // Suppress every key from the page, so nothing (scrolling, the omnibar, etc.) leaks through.
      suppressAllKeyboardEvents: true,
      suppressTrailingKeyEvents: true,
      exitOnEscape: true,
      exitOnClick: true,
      keydown: this.onKeyDown.bind(this),
    });
    this.mode.onExit(() => this.cleanup());

    this.render();
  }

  cleanup() {
    this.removeUi();
    HUD.hide(true, false);
  }

  removeUi() {
    if (this.containerEl) {
      this.containerEl.remove();
      this.containerEl = null;
    }
    this.markers = [];
  }

  // Rebuild the on-screen highlights + labels for the current `this.matches`.
  render() {
    this.removeUi();
    this.labelSeq = "";
    const matches = this.matches;

    if (matches.length > 0) {
      const container = DomUtils.createElement("div");
      container.id = "vimium-flash-marker-container";
      container.className = "vimium-reset";

      // Convert viewport-relative rects to page coordinates (like link_hints), so the hints stay
      // aligned with their matches when the page is scrolled.
      const offset = DomUtils.getViewportTopLeft();

      // Each marker keeps its hint label and highlight box together, so refreshLabelVisibility()
      // can hide them as one as the label is narrowed.
      this.markers = matches.map((match) => this.createMarkerFor(match, offset));
      new AlphabetHints().fillInMarkers(this.markers);
      for (const marker of this.markers) {
        container.appendChild(marker.highlight);
        container.appendChild(marker.element);
      }

      document.documentElement.appendChild(container);
      this.containerEl = container;

      // Top layer so hints paint above every stacking context; absolute keeps them page-anchored.
      if (container.showPopover != null) {
        container.popover = "manual";
        container.showPopover();
        Object.assign(container.style, {
          top: 0,
          left: 0,
          position: "absolute",
          display: "block",
          width: "100%",
          height: "100%",
          overflow: "visible",
        });
      }
    }

    this.updateHud();
  }

  createHighlightFor(rect, offset) {
    const el = DomUtils.createElement("div");
    el.className = "vimium-reset vimium-flash-highlight";
    Object.assign(el.style, {
      position: "absolute",
      left: (rect.left + offset.left) + "px",
      top: (rect.top + offset.top) + "px",
      width: rect.width + "px",
      height: rect.height + "px",
      background: "rgba(255, 160, 0, 0.25)",
      outline: "1px solid #ffa000",
      boxSizing: "border-box",
      pointerEvents: "none",
      zIndex: "2147483646",
    });
    return el;
  }

  // A marker compatible with AlphabetHints.fillInMarkers(), carrying its hint label (`element`) and
  // highlight box (`highlight`), positioned in page coordinates.
  createMarkerFor(match, offset) {
    const el = DomUtils.createElement("div");
    el.className = "vimium-reset internal-vimium-hint-marker vimiumHintMarker";
    el.style.left = (match.rect.left + offset.left) + "px";
    el.style.top = (match.rect.top + offset.top) + "px";
    // Sit the label just to the left of the match instead of on top of its first letters.
    el.style.transform = "translateX(-100%)";
    return {
      hintString: "",
      element: el,
      highlight: this.createHighlightFor(match.rect, offset),
      match,
      isLocalMarker() {
        return true;
      },
    };
  }

  updateHud() {
    // Echo the label keys once the query stops growing, so it's clear they now select a hint.
    const label = this.labelSeq ? "  " + this.labelSeq.toUpperCase() : "";
    HUD.show("flash: " + (this.query || "") + label);
  }

  // Apply a new query string: recompute matches, re-render, and auto-jump if it's now unambiguous.
  setQuery(query, matches) {
    this.query = query;
    this.matches = matches || (query ? collectFlashMatches(query, this.maxMatches) : []);
    this.render();
    if (this.autojump && (this.matches.length === 1)) {
      this.jumpToMatch(this.matches[0]);
    }
  }

  // Hide the label + highlight for any match whose hint string does not start with the keys pressed
  // so far, so only the still-selectable matches remain visible as the label is narrowed down.
  refreshLabelVisibility() {
    const seq = this.labelSeq.toLowerCase();
    for (const marker of this.markers) {
      const visible = !seq || marker.hintString.startsWith(seq);
      marker.element.style.display = visible ? "" : "none";
      marker.highlight.style.display = visible ? "" : "none";
    }
    this.updateHud();
  }

  jumpToMatch(match) {
    const range = match.range;
    this.mode.exit(); // tears down flash's handlers + UI, but leaves the page selection alone
    const selection = globalThis.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    // Enter Visual mode over the freshly-set selection (mirrors mode_normal.enterVisualMode()).
    new VisualMode().init({ userLaunchedMode: true });
  }

  // Suppress the key's default (e.g. <Space> scrolling) and stop it reaching the page. Under
  // suppressAllKeyboardEvents, returning suppressEvent (=== false) makes the wrapper call
  // preventDefault.
  onKeyDown(event) {
    if (!event.repeat) this.handleKey(event);
    return handlerStack.suppressEvent;
  }

  handleKey(event) {
    if (KeyboardUtils.isBackspace(event)) {
      if (this.labelSeq) {
        this.labelSeq = this.labelSeq.slice(0, -1);
        this.refreshLabelVisibility();
      } else if (this.query) {
        this.setQuery(this.query.slice(0, -1));
      } else {
        this.mode.exit();
      }
      return;
    }

    if (event.key === "Enter") {
      if (this.matches.length > 0) {
        this.jumpToMatch(this.matches[0]);
      } else {
        this.mode.exit();
      }
      return;
    }

    // Only plain printable single characters (including <Space>) build the query or select a label;
    // ignore anything held with Ctrl/Alt/Meta so page/browser chords aren't typed into the query.
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const ch = (event.key && (event.key.length === 1)) ? event.key : "";
    if (!ch) return;

    // 1) Prefer extending the query. A keystroke only becomes a label once it no longer matches
    // anything on screen -- so a label char that happens to continue a match extends the query.
    if (!this.labelSeq) {
      const extended = collectFlashMatches(this.query + ch, this.maxMatches);
      if (extended.length > 0) {
        this.setQuery(this.query + ch, extended);
        return;
      }
    }

    // 2) Otherwise treat the key as (part of) a label for the current, still-ambiguous matches.
    const seq = (this.labelSeq + ch).toLowerCase();
    const remaining = this.markers.filter((m) => m.hintString.startsWith(seq));
    if (remaining.length === 0) return;
    const exact = remaining.find((m) => m.hintString === seq);
    if (exact && (remaining.length === 1)) {
      this.jumpToMatch(exact.match);
    } else {
      this.labelSeq += ch;
      this.refreshLabelVisibility();
    }
  }
}

const Flash = {
  activateMode(_count, options) {
    if (options == null) options = {};
    const cmdOptions = (options.registryEntry && options.registryEntry.options) || {};
    const autojump = (cmdOptions.autojump === true) || (cmdOptions.autojump === "true");
    const max = parseInt(cmdOptions.max, 10) || undefined;
    return new FlashMode({ autojump, max });
  },
};

globalThis.Flash = Flash;
globalThis.FlashMode = FlashMode;
