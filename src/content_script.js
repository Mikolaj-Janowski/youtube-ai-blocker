// content_script.js (upgraded)
// In-browser optimized content script for YouTube AI blocker.
// Supports: TF.js USE (local) OR remote backend embeddings.
// Features: embedding cache, intersection-only embedding, batching, debounce,
// placeholder UI with Undo / "Not similar" feedback (negative examples).

import * as tf from "@tensorflow/tfjs";
import * as use from "@tensorflow-models/universal-sentence-encoder";

/* ---------------- Configuration keys ---------------- */
const STORAGE_KEY = "ytd_ai_blocked_items_v2"; // blocked positives
const CACHE_KEY = "ytd_ai_cache_v2";           // map text -> embedding array
const NEGATIVE_KEY = "ytd_ai_negative_v2";     // negative examples
const THRESHOLD_KEY = "ytd_ai_threshold_v2";
const MODE_KEY = "ytd_ai_mode_v2";             // 'local' or 'remote'
const BACKEND_KEY = "ytd_ai_backend_v2";

const DEFAULT_THRESHOLD = 0.82;
const EMBED_BATCH_SIZE = 8;  // batch size for embedding in local mode

/* ---------------- Globals ---------------- */
let model = null;
let blockedItems = []; // {id, title, channel, embedding}
let negativeItems = []; // {id, title, channel, embedding}
let cache = {}; // persistent cache loaded from storage (title->embedding array)
let runtimeCache = new Map(); // in-memory cache title->Float32Array
let threshold = DEFAULT_THRESHOLD;
let mode = "local";
let backendUrl = "";

let embedQueue = []; // queue of {text, resolve}

// For debouncing DOM observer
let mutateTimer = null;

/* ---------------- Helpers ---------------- */
function cosineSimilarity(a, b) {
  let dot = 0, norma = 0, normb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    norma += a[i] * a[i];
    normb += b[i] * b[i];
  }
  if (norma === 0 || normb === 0) return 0;
  return dot / (Math.sqrt(norma) * Math.sqrt(normb));
}

function saveToStorage(keys) {
  // keys is object e.g. { [STORAGE_KEY]: blockedItems }
  chrome.storage.local.set(keys);
}

/* ---------------- Storage load ---------------- */
async function loadState() {
  const data = await new Promise(res => chrome.storage.local.get([STORAGE_KEY, CACHE_KEY, NEGATIVE_KEY, THRESHOLD_KEY, MODE_KEY, BACKEND_KEY], res));
  blockedItems = data[STORAGE_KEY] || [];
  cache = data[CACHE_KEY] || {};
  negativeItems = data[NEGATIVE_KEY] || [];
  threshold = data[THRESHOLD_KEY] || DEFAULT_THRESHOLD;
  mode = data[MODE_KEY] || "local";
  backendUrl = data[BACKEND_KEY] || "";
  // populate runtimeCache
  for (const k of Object.keys(cache)) {
    runtimeCache.set(k, Float32Array.from(cache[k]));
  }
}

/* ---------------- TF.js model loader ---------------- */
async function ensureModel() {
  if (mode === "remote") return;
  if (!model) {
    model = await use.load();
    await model.embed(["init"]);
    console.log("USE model loaded (local)");
  }
}

/* ---------------- Embedding APIs ---------------- */
async function embedLocalBatch(texts) {
  await ensureModel();
  const embeddings = await model.embed(texts); // tf.Tensor [N, dim]
  const arr = await embeddings.array();
  embeddings.dispose();
  return arr; // array of arrays
}

async function embedRemote(text) {
  if (!backendUrl) throw new Error("Backend URL not configured.");
  const resp = await fetch(`${backendUrl.replace(/\/$/, "")}/embed`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({texts: [text]})
  });
  if (!resp.ok) throw new Error("Remote embed failed: " + resp.status);
  const data = await resp.json();
  return data.embeddings[0]; // array
}

function getCacheKey(text) {
  // normalize similar texts
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

async function embed(text) {
  // returns Float32Array embedding
  const key = getCacheKey(text);
  if (runtimeCache.has(key)) return runtimeCache.get(key);
  // check persistent cache
  if (cache[key]) {
    const arr = Float32Array.from(cache[key]);
    runtimeCache.set(key, arr);
    return arr;
  }
  // Queue for batched local embeddings or fire remote call
  if (mode === "remote") {
    const embArr = await embedRemote(text);
    const arr = Float32Array.from(embArr);
    runtimeCache.set(key, arr);
    cache[key] = Array.from(arr);
    saveToStorage({ [CACHE_KEY]: cache });
    return arr;
  } else {
    // Local: batch small groups with a short wait to gather items
    return new Promise((resolve, reject) => {
      embedQueue.push({ text, key, resolve, reject });
      if (embedQueue.length >= EMBED_BATCH_SIZE) processEmbedQueue();
      // also schedule processing after brief delay if queue isn't full
      setTimeout(() => {
        if (embedQueue.length > 0) processEmbedQueue();
      }, 80);
    });
  }
}

async function processEmbedQueue() {
  const q = embedQueue.splice(0, EMBED_BATCH_SIZE);
  const texts = q.map(x => x.text);
  try {
    const embedded = await embedLocalBatch(texts);
    for (let i = 0; i < embedded.length; i++) {
      const arr = Float32Array.from(embedded[i]);
      const key = q[i].key;
      runtimeCache.set(key, arr);
      cache[key] = Array.from(arr);
      q[i].resolve(arr);
    }
    // persist cache
    saveToStorage({ [CACHE_KEY]: cache });
  } catch (err) {
    for (const item of q) item.reject(err);
  }
}

/* ---------------- Blocking logic ---------------- */
function addBlockedItem(title, channel, embedding) {
  const id = `blocked_${Date.now()}_${Math.floor(Math.random()*10000)}`;
  blockedItems.push({ id, title, channel, embedding: Array.from(embedding) });
  saveToStorage({ [STORAGE_KEY]: blockedItems });
  return id;
}

function addNegativeItem(title, channel, embedding) {
  const id = `neg_${Date.now()}_${Math.floor(Math.random()*10000)}`;
  negativeItems.push({ id, title, channel, embedding: Array.from(embedding) });
  saveToStorage({ [NEGATIVE_KEY]: negativeItems });
  return id;
}

function removeBlockedById(id) {
  blockedItems = blockedItems.filter(x => x.id !== id);
  saveToStorage({ [STORAGE_KEY]: blockedItems });
}

/* ---------------- Determine blocking ---------------- */
async function shouldBlockText(title, channel) {
  if (!blockedItems || blockedItems.length === 0) return { block: false };
  const text = `${title} — ${channel}`;
  const emb = await embed(text);
  // check negative items first: if candidate similar to negative > thresholdNeg => never block
  for (const neg of negativeItems) {
    const simNeg = cosineSimilarity(emb, Float32Array.from(neg.embedding));
    if (simNeg >= threshold) {
      return { block: false, reason: "matched_negative", simNeg };
    }
  }
  // check positives
  for (const b of blockedItems) {
    const sim = cosineSimilarity(emb, Float32Array.from(b.embedding));
    if (sim >= threshold) {
      return { block: true, matched: b, sim };
    }
  }
  return { block: false };
}

/* ---------------- UI: attach Block button & placeholder ---------------- */
function createBlockButton() {
  const btn = document.createElement("button");
  btn.innerText = "Block";
  btn.title = "Block this video and similar content (AI learns from this)";
  btn.className = "ytd-ai-blocker-btn";
  btn.style.cssText = "padding:6px 8px;margin-left:6px;border-radius:4px;border:1px solid #888;background:#fff;cursor:pointer;font-size:12px;";
  return btn;
}

function createPlaceholder(matchedTitle, matchedChannel, matchedId, matchedSim) {
  const wrapper = document.createElement("div");
  wrapper.className = "ytd-ai-blocker-placeholder";
  wrapper.style.cssText = "padding:8px;border:1px dashed #ccc;background:#fff;margin:6px 0;font-size:13px;";
  wrapper.innerHTML = `<div style="font-weight:600">Blocked by AI</div>
    <div style="font-size:12px;color:#444;margin-top:4px;">Matched: ${escapeHtml(matchedTitle)} — ${escapeHtml(matchedChannel)} (sim ${matchedSim.toFixed(2)})</div>
    <div style="margin-top:8px;">
      <button class="ai-unblock-btn" style="margin-right:8px">Show this</button>
      <button class="ai-negative-btn">Not similar</button>
    </div>`;
  return wrapper;
}

/* ---------------- Utilities ---------------- */
function escapeHtml(s) {
  return s ? s.replace(/[&<>"']/g, function(m){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]); }) : "";
}

function extractVideoInfoFromTile(tile) {
  let titleEl =
    tile.querySelector("#video-title") ||
    tile.querySelector("a#video-title") ||
    tile.querySelector("h3") ||
    tile.querySelector("yt-formatted-string#video-title");
  let titleText = titleEl ? titleEl.textContent.trim() : (tile.innerText || "").split("\n")[0] || "unknown title";
  let channelEl =
    tile.querySelector(".ytd-channel-name") ||
    tile.querySelector("#channel-name") ||
    tile.querySelector(".yt-simple-endpoint.style-scope.yt-formatted-string");
  let channelText = channelEl ? channelEl.innerText.trim() : "unknown channel";
  return { titleText, channelText };
}

/* ---------------- Scanning & Observers ---------------- */
function findVideoTiles() {
  const selectors = [
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-rich-item-renderer",
    "ytd-compact-video-renderer",
    "#dismissible"
  ];
  const tiles = new Set();
  selectors.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => tiles.add(el));
  });
  return Array.from(tiles);
}

let intersectionObserver = null;

function observeViewportAndAttach(tiles) {
  if (!intersectionObserver) {
    intersectionObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const tile = entry.target;
          attachButtonsToTile(tile);
          // when enters viewport, scan & maybe hide
          // use idle time
          if (window.requestIdleCallback) {
            requestIdleCallback(() => scanAndMaybeHideTile(tile));
          } else {
            setTimeout(() => scanAndMaybeHideTile(tile), 150);
          }
          intersectionObserver.unobserve(tile); // don't repeatedly process same tile
        }
      });
    }, { root: null, rootMargin: "200px", threshold: 0.01 });
  }
  tiles.forEach(t => intersectionObserver.observe(t));
}

function attachButtonsToTile(tile) {
  if (tile.querySelector(".ytd-ai-blocker-btn") || tile.querySelector(".ytd-ai-blocker-placeholder")) return;
  const btn = createBlockButton();
  btn.onclick = async (e) => {
    e.stopPropagation();
    btn.disabled = true;
    btn.innerText = "Learning...";
    try {
      const { titleText, channelText } = extractVideoInfoFromTile(tile);
      const textForEmbed = `${titleText} — ${channelText}`;
      const emb = await embed(textForEmbed);
      const id = addBlockedItem(titleText, channelText, emb);
      // hide tile
      hideTileWithPlaceholder(tile, id, titleText, channelText, 1.0 /* local placeholder sim */);
    } catch (err) {
      console.error("Block failed", err);
      btn.disabled = false;
      btn.innerText = "Block";
    }
  };

  // try to insert the button in common meta container
  const insertionPoint = tile.querySelector("#meta, #overlays, #details, #content");
  if (insertionPoint) {
    insertionPoint.appendChild(btn);
  } else {
    // fallback: append to tile
    tile.appendChild(btn);
  }
}

function hideTileWithPlaceholder(tile, matchedId, matchedTitle, matchedChannel, matchedSim) {
  // replace tile's content with placeholder but keep a reference to restore
  const placeholder = createPlaceholder(matchedTitle, matchedChannel, matchedId, matchedSim);
  const originalDisplay = tile.style.display;
  const originalChildren = Array.from(tile.childNodes).map(n => n.cloneNode(true));
  tile.innerHTML = "";
  tile.appendChild(placeholder);

  const unblockBtn = placeholder.querySelector(".ai-unblock-btn");
  const negativeBtn = placeholder.querySelector(".ai-negative-btn");

  unblockBtn.addEventListener("click", () => {
    // restore original content
    tile.innerHTML = "";
    for (const n of originalChildren) tile.appendChild(n);
    tile.style.display = originalDisplay;
  });

  negativeBtn.addEventListener("click", async () => {
    // add the matched blocked example as a negative to prevent similar blocking
    try {
      // matchedId corresponds to blockedItems entry. If not found, create negative from current tile
      let matched = blockedItems.find(x => x.id === matchedId);
      if (matched) {
        addNegativeItem(matched.title, matched.channel, Float32Array.from(matched.embedding));
      } else {
        const { titleText, channelText } = extractVideoInfoFromTile(tile);
        const emb = await embed(`${titleText} — ${channelText}`);
        addNegativeItem(titleText, channelText, emb);
      }
      alert("Marked as not similar — the filter will avoid blocking similar items.");
      // remove placeholder and restore tile
      tile.innerHTML = "";
      for (const n of originalChildren) tile.appendChild(n);
      tile.style.display = originalDisplay;
    } catch (err) {
      console.error("Failed to add negative:", err);
    }
  });

  // hide tile visually (already replaced by placeholder)
}

/* ---------------- Scanning a tile ---------------- */
async function scanAndMaybeHideTile(tile) {
  try {
    const { titleText, channelText } = extractVideoInfoFromTile(tile);
    // quick exact-match check
    if (blockedItems.some(b => b.title === titleText || b.channel === channelText)) {
      // find matched blocked item
      const matched = blockedItems.find(b => b.title === titleText || b.channel === channelText);
      hideTileWithPlaceholder(tile, matched.id, matched.title, matched.channel, 1.0);
      return;
    }

    const res = await shouldBlockText(titleText, channelText);
    if (res.block) {
      hideTileWithPlaceholder(tile, res.matched.id, res.matched.title, res.matched.channel, res.sim);
    }
  } catch (err) {
    console.error("scanAndMaybeHideTile error:", err);
  }
}

/* ---------------- MutationObserver (debounced) ---------------- */
let observer = null;
function startObserving() {
  if (observer) return;
  const root = document.body;
  observer = new MutationObserver((mutations) => {
    if (mutateTimer) clearTimeout(mutateTimer);
    mutateTimer = setTimeout(() => {
      const tiles = findVideoTiles();
      observeViewportAndAttach(tiles);
    }, 220); // debounce for 220ms
  });
  observer.observe(root, { childList: true, subtree: true });

  // initial pass
  const tiles = findVideoTiles();
  observeViewportAndAttach(tiles);
}

/* ---------------- Storage change listener (popup changes) ---------------- */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes[STORAGE_KEY]) blockedItems = changes[STORAGE_KEY].newValue || [];
    if (changes[CACHE_KEY]) {
      cache = changes[CACHE_KEY].newValue || {};
      runtimeCache = new Map();
      for (const k of Object.keys(cache)) runtimeCache.set(k, Float32Array.from(cache[k]));
    }
    if (changes[NEGATIVE_KEY]) negativeItems = changes[NEGATIVE_KEY].newValue || [];
    if (changes[THRESHOLD_KEY]) threshold = changes[THRESHOLD_KEY].newValue || DEFAULT_THRESHOLD;
    if (changes[MODE_KEY]) mode = changes[MODE_KEY].newValue || "local";
    if (changes[BACKEND_KEY]) backendUrl = changes[BACKEND_KEY].newValue || "";
  }
});

/* ---------------- Bootstrap ---------------- */
(async function bootstrap() {
  try {
    await loadState();
    if (mode === "local") await ensureModel();
    // initial attach + observe
    startObserving();
    console.log("YouTube AI Blocker upgraded content script started. Mode:", mode, "threshold:", threshold);
  } catch (err) {
    console.error("Bootstrap error:", err);
  }
})();
