// content_script.js
// Runs on youtube pages. Uses Universal Sentence Encoder (TF.js) to embed text,
// stores blocked embeddings, and hides similar videos automatically.

// Imports (esbuild will bundle @tensorflow/tfjs and USE)
import * as tf from "@tensorflow/tfjs";
import * as use from "@tensorflow-models/universal-sentence-encoder";

/* ---------- Configuration ---------- */
const STORAGE_KEY = "ytd_ai_blocked_items_v1"; // stores array of {id, title, channel, embedding}
const THRESHOLD_KEY = "ytd_ai_threshold_v1";
const DEFAULT_THRESHOLD = 0.82; // similarity threshold (cosine). Tweak as needed.

/* ---------- Globals ---------- */
let model = null;
let blockedItems = []; // loaded from chrome.storage
let threshold = DEFAULT_THRESHOLD;

/* ---------- Helpers ---------- */
function cosineSimilarity(a, b) {
  // a, b are Float32Array or arrays of numbers
  let dot = 0.0, norma = 0.0, normb = 0.0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    norma += a[i] * a[i];
    normb += b[i] * b[i];
  }
  if (norma === 0 || normb === 0) return 0;
  return dot / (Math.sqrt(norma) * Math.sqrt(normb));
}

function saveBlockedItems() {
  chrome.storage.local.set({ [STORAGE_KEY]: blockedItems });
}

function saveThreshold() {
  chrome.storage.local.set({ [THRESHOLD_KEY]: threshold });
}

async function loadSettings() {
  const data = await new Promise((resolve) =>
    chrome.storage.local.get([STORAGE_KEY, THRESHOLD_KEY], resolve)
  );
  blockedItems = data[STORAGE_KEY] || [];
  threshold = data[THRESHOLD_KEY] || DEFAULT_THRESHOLD;
}

/* ---------- Model loading ---------- */
async function ensureModel() {
  if (!model) {
    model = await use.load();
    // warm up
    await model.embed(["hello"]);
    console.log("USE model loaded in content script");
  }
}

/* ---------- Embedding helpers ---------- */
async function embedText(text) {
  await ensureModel();
  const embeddings = await model.embed([text]); // shape [1, dim]
  const arr = await embeddings.array();
  embeddings.dispose();
  return arr[0];
}

/* ---------- UI helpers: add "Block" button to each video tile ---------- */
function createBlockButton() {
  const btn = document.createElement("button");
  btn.innerText = "Block";
  btn.title = "Block this video + similar content (AI learns from this)";
  btn.style.padding = "6px 8px";
  btn.style.marginLeft = "6px";
  btn.style.borderRadius = "4px";
  btn.style.border = "1px solid #888";
  btn.style.background = "#fff";
  btn.style.cursor = "pointer";
  btn.style.fontSize = "12px";
  btn.className = "ytd-ai-blocker-btn";
  return btn;
}

function attachButtonsToTile(tile) {
  // tile is an element that contains title + channel info (YouTube's structure varies; try to be robust)
  if (tile.querySelector(".ytd-ai-blocker-btn")) return; // already attached
  const btn = createBlockButton();
  btn.onclick = async (e) => {
    e.stopPropagation();
    btn.disabled = true;
    btn.innerText = "Learning...";
    try {
      const { titleText, channelText } = extractVideoInfoFromTile(tile);
      const textForEmbed = `${titleText} — ${channelText}`;
      const emb = await embedText(textForEmbed);
      const id = `blocked_${Date.now()}`;
      blockedItems.push({
        id,
        title: titleText,
        channel: channelText,
        embedding: Array.from(emb)
      });
      saveBlockedItems();
      btn.innerText = "Blocked";
      btn.style.opacity = 0.6;
      // Optionally hide the tile immediately
      tile.style.display = "none";
    } catch (err) {
      console.error("Block failed", err);
      btn.disabled = false;
      btn.innerText = "Block";
    }
  };

  // insert button into tile. Try common insertion points:
  // - For search results / feed: look for the metadata container
  const insertionPoint = tile.querySelector("#meta, #overlays, ytd-video-renderer, ytd-grid-video-renderer, #details, #content");
  if (insertionPoint) {
    insertionPoint.appendChild(btn);
  } else {
    tile.appendChild(btn);
  }
}

/* ---------- Extraction helper: robustly get title and channel text ---------- */
function extractVideoInfoFromTile(tile) {
  // title
  let titleEl =
    tile.querySelector("#video-title") ||
    tile.querySelector("a#video-title") ||
    tile.querySelector("h3") ||
    tile.querySelector("yt-formatted-string#video-title");
  let titleText = titleEl ? titleEl.textContent.trim() : (tile.innerText || "").split("\n")[0] || "unknown title";
  // channel
  let channelEl =
    tile.querySelector(".ytd-channel-name") ||
    tile.querySelector("#channel-name") ||
    tile.querySelector(".yt-simple-endpoint.style-scope.yt-formatted-string");
  let channelText = channelEl ? channelEl.innerText.trim() : "unknown channel";
  return { titleText, channelText };
}

/* ---------- Scanning and blocking logic ---------- */
async function shouldBlockText(title, channel) {
  if (!blockedItems || blockedItems.length === 0) return false;
  const text = `${title} — ${channel}`;
  const emb = await embedText(text); // Float32Array
  for (const b of blockedItems) {
    const sim = cosineSimilarity(emb, b.embedding);
    if (sim >= threshold) {
      return { block: true, matched: b, sim };
    }
  }
  return { block: false };
}

async function scanAndMaybeHideTile(tile) {
  try {
    const { titleText, channelText } = extractVideoInfoFromTile(tile);
    // quick exact-match check to save compute:
    if (blockedItems.some(b => b.title === titleText || b.channel === channelText)) {
      tile.style.display = "none";
      return;
    }
    const res = await shouldBlockText(titleText, channelText);
    if (res.block) {
      tile.style.display = "none";
      // Optionally add a small placeholder (uncomment if you want visible placeholder)
      // const placeholder = document.createElement("div"); placeholder.innerText = "Blocked by AI filter"; tile.parentNode.insertBefore(placeholder, tile);
      console.log("Blocked by AI filter:", titleText, "matched", res.matched.title, "sim", res.sim);
    }
  } catch (err) {
    // keep failure silent to not disrupt page
    console.error("scanAndMaybeHideTile error:", err);
  }
}

/* ---------- MutationObserver & initial scan ---------- */
function findVideoTiles() {
  // various selectors for YouTube thumbnails / video tiles
  const selectors = [
    "ytd-video-renderer", // search results
    "ytd-grid-video-renderer", // channel grid
    "ytd-rich-item-renderer", // homepage / feed
    "ytd-compact-video-renderer", // side
    "ytd-video-renderer", ".yt-simple-endpoint.style-scope.ytd-grid-video-renderer" // fallback
  ];
  const tiles = new Set();
  selectors.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => tiles.add(el));
  });
  // also include elements with id 'dismissible' which are commonly used around thumbnails
  document.querySelectorAll("#dismissible").forEach(el => tiles.add(el));
  return Array.from(tiles);
}

let observer = null;

function startObserving() {
  if (observer) return;
  const root = document.body;
  observer = new MutationObserver(async (mutations) => {
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length) {
        for (const node of m.addedNodes) {
          try {
            if (!(node instanceof HTMLElement)) continue;
            // if node itself is a tile or contains tiles:
            const possibleTiles = [];
            if (node.matches && node.matches("ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, #dismissible")) {
              possibleTiles.push(node);
            }
            node.querySelectorAll && node.querySelectorAll("ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, #dismissible").forEach(t => possibleTiles.push(t));
            for (const t of possibleTiles) {
              attachButtonsToTile(t);
              // scan asynchronously but don't block UI
              scanAndMaybeHideTile(t);
            }
          } catch (err) {
            // ignore
          }
        }
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
}

/* ---------- Initial bootstrap ---------- */
(async function bootstrap() {
  try {
    await loadSettings();
    await ensureModel();
    // initial scan: find tiles, attach buttons, scan them
    const tiles = findVideoTiles();
    for (const t of tiles) {
      attachButtonsToTile(t);
    }
    // run scans in batches to avoid freezing (sequential)
    (async () => {
      for (const t of tiles) {
        await scanAndMaybeHideTile(t);
      }
    })();
    // start observing for dynamic changes
    startObserving();

    // optional: listen for storage changes (e.g., when popup changes threshold)
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") {
        if (changes[STORAGE_KEY]) {
          blockedItems = changes[STORAGE_KEY].newValue || [];
        }
        if (changes[THRESHOLD_KEY]) {
          threshold = changes[THRESHOLD_KEY].newValue || DEFAULT_THRESHOLD;
        }
      }
    });

    console.log("YouTube AI Blocker content script initialized. Threshold:", threshold, "blocked items:", blockedItems.length);
  } catch (err) {
    console.error("Bootstrap error:", err);
  }
})();
