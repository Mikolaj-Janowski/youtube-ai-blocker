// content_script.js (upgraded)
// In-browser optimized content script for YouTube AI blocker.
// Supports: ONNX (local) OR remote backend embeddings.
// Features: embedding cache, intersection-only embedding, batching, debounce,
// placeholder UI with Undo / "Not similar" feedback (negative examples).
// Hybrid Mode: Uses both similarity matching AND logistic regression classifier

// Content script delegates embedding to background worker
// This avoids CORS/network restrictions in content scripts

import { LogisticRegressionClassifier } from './classifier.js';

/* ---------------- Configuration keys ---------------- */
const STORAGE_KEY = "ytd_ai_blocked_items_v2"; // blocked positives
const CACHE_KEY = "ytd_ai_cache_v2";           // map text -> embedding array
const NEGATIVE_KEY = "ytd_ai_negative_v2";     // negative examples ("don't block")
const ALLOWED_KEY = "ytd_ai_allowed_v2";       // explicitly allowed items (user clicked "show this")
const THRESHOLD_KEY = "ytd_ai_threshold_v2";
const MODE_KEY = "ytd_ai_mode_v2";             // 'local' or 'remote'
const BACKEND_KEY = "ytd_ai_backend_v2";
const CLASSIFIER_KEY = "ytd_ai_classifier_v2"; // trained classifier model
const CLASSIFIER_ENABLED_KEY = "ytd_ai_classifier_enabled_v2"; // on/off toggle
const AUTO_THRESHOLD_KEY = "ytd_ai_auto_threshold_v2"; // automatic threshold adaptation toggle
const ADAPT_STATS_KEY = "ytd_ai_adapt_stats_v2";       // adaptation statistics

const DEFAULT_THRESHOLD = 0.7;
const EMBED_BATCH_SIZE = 8;  // batch size for embedding in local mode
const MIN_POSITIVES_FOR_TRAINING = 10; // minimum blocked items to train classifier
const MIN_NEGATIVES_FOR_TRAINING = 20;  // minimum negative examples to train classifier

// Automatic threshold adaptation constants
const ADAPT_STEP = 0.02;       // Amount to change threshold per adaptation event
const ADAPT_FLOOR = 0.30;      // Minimum possible threshold
const ADAPT_CEILING = 0.95;    // Maximum possible threshold
const ADAPT_FN_MIN_SIM = 0.40; // Min similarity to existing blocked items to trigger FN detection

/* ---------------- Globals ---------------- */
let extractor = null; // Not used - delegated to background worker
let blockedItems = []; // {id, title, channel, embedding}
let negativeItems = []; // {id, title, channel, embedding} - "don't block" examples
let allowedItems = []; // {id, title, channel, timestamp} - explicitly allowed by user
let cache = {}; // persistent cache loaded from storage (title->embedding array)
let runtimeCache = new Map(); // in-memory cache title->Float32Array
let threshold = DEFAULT_THRESHOLD;
let mode = "local";
let backendUrl = "";
let classifier = new LogisticRegressionClassifier(); // logistic regression classifier
let classifierEnabled = false; // whether to use classifier in predictions
let autoThresholdEnabled = false; // whether to auto-adapt threshold from feedback
let adaptStats = { up: 0, down: 0 }; // track how many times threshold was adapted

let embedQueue = []; // queue of {text, resolve}

// For debouncing DOM observer
let mutateTimer = null;

// Track recently unblocked tiles to avoid immediate re-blocking
let recentlyUnblocked = new Set();

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
  const data = await new Promise(res => chrome.storage.local.get([
    STORAGE_KEY, CACHE_KEY, NEGATIVE_KEY, ALLOWED_KEY, THRESHOLD_KEY, MODE_KEY, BACKEND_KEY,
    CLASSIFIER_KEY, CLASSIFIER_ENABLED_KEY, AUTO_THRESHOLD_KEY, ADAPT_STATS_KEY
  ], res));
  
  blockedItems = data[STORAGE_KEY] || [];
  cache = data[CACHE_KEY] || {};
  negativeItems = data[NEGATIVE_KEY] || [];
  allowedItems = data[ALLOWED_KEY] || [];
  threshold = data[THRESHOLD_KEY] || DEFAULT_THRESHOLD;
  mode = data[MODE_KEY] || "local";
  backendUrl = data[BACKEND_KEY] || "";
  classifierEnabled = data[CLASSIFIER_ENABLED_KEY] || false;
  autoThresholdEnabled = data[AUTO_THRESHOLD_KEY] || false;
  adaptStats = data[ADAPT_STATS_KEY] || { up: 0, down: 0 };
  
  // Load classifier if it exists
  if (data[CLASSIFIER_KEY]) {
    classifier.fromJSON(data[CLASSIFIER_KEY]);
    console.log("Classifier loaded:", classifier.getStats());
  }
  
  // populate runtimeCache
  for (const k of Object.keys(cache)) {
    runtimeCache.set(k, Float32Array.from(cache[k]));
  }
}

/* ---------------- MiniLM-L6-v2 model loader (in background worker) ---------------- */
async function ensureModel() {
  // Model is loaded in background worker - content script just delegates
  // No action needed here
}

/* ---------------- Embedding APIs (delegated to background worker) ---------------- */
async function embedLocalBatch(texts) {
  // Content script delegates to background worker to avoid CORS restrictions
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "embed", texts }, (response) => {
      if (response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response.embeddings);
      }
    });
  });
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
  
  // Trigger classifier retraining if enabled and enough data
  if (classifierEnabled) {
    setTimeout(() => maybeTrainClassifier(), 100);
  }
  
  return id;
}

function addNegativeItem(title, channel, embedding) {
  const id = `neg_${Date.now()}_${Math.floor(Math.random()*10000)}`;
  negativeItems.push({ id, title, channel, embedding: Array.from(embedding) });
  saveToStorage({ [NEGATIVE_KEY]: negativeItems });
  
  // Trigger classifier retraining if enabled and enough data
  if (classifierEnabled) {
    setTimeout(() => maybeTrainClassifier(), 100);
  }
  
  return id;
}

function addAllowedItem(title, channel) {
  const id = `allow_${Date.now()}_${Math.floor(Math.random()*10000)}`;
  const item = { id, title, channel, timestamp: Date.now() };
  allowedItems.push(item);
  saveToStorage({ [ALLOWED_KEY]: allowedItems });
  console.log(`Added to allowed list: "${title}" by "${channel}". Total allowed: ${allowedItems.length}`);
  return id;
}

function removeAllowedItem(title, channel) {
  allowedItems = allowedItems.filter(a => !(a.title === title && a.channel === channel));
  saveToStorage({ [ALLOWED_KEY]: allowedItems });
}

function removeBlockedById(id) {
  blockedItems = blockedItems.filter(x => x.id !== id);
  saveToStorage({ [STORAGE_KEY]: blockedItems });
}

/* ---------------- Classifier Training ---------------- */
async function maybeTrainClassifier() {
  if (!classifierEnabled) {
    console.log("Classifier disabled, skipping training");
    return;
  }
  
  // Check if we have enough data
  if (blockedItems.length < MIN_POSITIVES_FOR_TRAINING || 
      negativeItems.length < MIN_NEGATIVES_FOR_TRAINING) {
    console.log(`Not enough data to train classifier. Need ${MIN_POSITIVES_FOR_TRAINING} blocked (have ${blockedItems.length}), ${MIN_NEGATIVES_FOR_TRAINING} negatives (have ${negativeItems.length})`);
    return;
  }
  
  console.log(`Training classifier on ${blockedItems.length} positives and ${negativeItems.length} negatives...`);
  
  // Prepare training data
  const positives = [];
  const negatives = [];
  
  // Collect positive examples (blocked items)
  for (const item of blockedItems) {
    positives.push(Float32Array.from(item.embedding));
  }
  
  // Collect negative examples
  for (const item of negativeItems) {
    negatives.push(Float32Array.from(item.embedding));
  }
  
  // Balance dataset to prevent bias toward majority class
  const minCount = Math.min(positives.length, negatives.length);
  const maxCount = Math.max(positives.length, negatives.length);
  const imbalanceRatio = maxCount / minCount;
  
  console.log(`Data balance: ${positives.length} positives, ${negatives.length} negatives (ratio: ${imbalanceRatio.toFixed(2)})`);
  
  // If severely imbalanced (>2:1), balance the dataset
  const X = [];
  const y = [];
  
  if (imbalanceRatio > 2.0) {
    console.log("Balancing dataset due to class imbalance...");
    // Undersample majority class
    const balancedCount = minCount;
    
    // Shuffle and take equal amounts
    const shuffledPos = [...positives].sort(() => Math.random() - 0.5);
    const shuffledNeg = [...negatives].sort(() => Math.random() - 0.5);
    
    for (let i = 0; i < balancedCount; i++) {
      X.push(shuffledPos[i]);
      y.push(1);
      X.push(shuffledNeg[i]);
      y.push(0);
    }
    console.log(`Balanced to ${balancedCount} examples per class`);
  } else {
    // Use all data if reasonably balanced
    for (const emb of positives) {
      X.push(emb);
      y.push(1);
    }
    for (const emb of negatives) {
      X.push(emb);
      y.push(0);
    }
  }
  
  // Train classifier with reduced regularization for better fit
  try {
    classifier.regularization = 0.0001; // Lower regularization
    const stats = classifier.train(X, y, 150, true); // More epochs
    console.log("Classifier training complete:", stats);
    
    // Save classifier to storage
    saveToStorage({ [CLASSIFIER_KEY]: classifier.toJSON() });
    
    return stats;
  } catch (err) {
    console.error("Classifier training failed:", err);
    return null;
  }
}

/* ---------------- Automatic Threshold Adaptation ---------------- */
function adaptThreshold(direction) {
  if (!autoThresholdEnabled) return;

  const oldThreshold = threshold;
  let newThreshold;

  if (direction === 'up') {
    newThreshold = Math.min(ADAPT_CEILING, Math.round((threshold + ADAPT_STEP) * 100) / 100);
    adaptStats.up = (adaptStats.up || 0) + 1;
  } else {
    newThreshold = Math.max(ADAPT_FLOOR, Math.round((threshold - ADAPT_STEP) * 100) / 100);
    adaptStats.down = (adaptStats.down || 0) + 1;
  }

  if (newThreshold !== oldThreshold) {
    threshold = newThreshold;
    const arrow = direction === 'up' ? '↑' : '↓';
    console.log(`[Auto-Threshold] ${arrow} Adapted: ${oldThreshold.toFixed(2)} → ${threshold.toFixed(2)} (↑${adaptStats.up} ↓${adaptStats.down})`);
    saveToStorage({
      [THRESHOLD_KEY]: threshold,
      [ADAPT_STATS_KEY]: { ...adaptStats }
    });
  }
}

/* ---------------- Determine blocking (Hybrid Mode) ---------------- */
async function shouldBlockText(title, channel) {
  if (!blockedItems || blockedItems.length === 0) return { block: false };
  
  // STEP 0: Check if explicitly allowed by user (clicked "Show this")
  const isAllowed = allowedItems.find(a => a.title === title && a.channel === channel);
  if (isAllowed) {
    console.log(`Video "${title}" is explicitly allowed (Show this was clicked)`);
    return { block: false, reason: "explicitly_allowed" };
  }
  
  const text = `${title} — ${channel}`;
  const emb = await embed(text);
  
  let blockReasons = [];
  let maxSim = 0;
  let matchedItem = null;
  
  // STEP 1: Check negative items ("don't block" - these are TRAINING data, not veto)
  // Negatives are now part of classifier training, not a separate veto check
  
  // STEP 2: Check similarity to blocked items
  for (const b of blockedItems) {
    const sim = cosineSimilarity(emb, Float32Array.from(b.embedding));
    if (sim > maxSim) {
      maxSim = sim;
      matchedItem = b;
    }
    if (sim >= threshold) {
      blockReasons.push({
        method: "similarity",
        confidence: sim,
        matched: b
      });
    }
  }
  
  // STEP 3: Check classifier prediction (if enabled and trained)
  // Use the same threshold as similarity matching for consistency
  if (classifierEnabled && classifier && classifier.isReady()) {
    try {
      const prob = classifier.predict(emb);
      
      // Classifier should respect user's threshold setting
      // Use threshold as classifier probability cutoff
      if (prob >= threshold) {
        blockReasons.push({
          method: "classifier",
          confidence: prob
        });
      }
      
      // Log classifier prediction for debugging (only if above 30% to reduce noise)
      if (prob >= 0.3) {
        console.log(`Classifier prediction for "${title}": ${(prob * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(0)}%)`);
      }
    } catch (err) {
      console.error("Classifier prediction error:", err);
    }
  }
  
  // DECISION: Block if ANY method says to block (hybrid OR logic)
  if (blockReasons.length > 0) {
    return {
      block: true,
      reasons: blockReasons,
      matched: matchedItem,
      sim: maxSim,
      numMethods: blockReasons.length
    };
  }
  
  return { block: false };
}

/* ---------------- UI: attach Block button & placeholder ---------------- */
function createBlockButton() {
  const btn = document.createElement("button");
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/></svg>`;
  btn.title = "Block this video and similar content";
  btn.className = "ytd-ai-blocker-btn ytd-ai-block-btn";
  btn.style.cssText = `
    padding: 8px;
    margin-left: 8px;
    border-radius: 6px;
    border: 2px solid #ef4444;
    background: white;
    cursor: pointer;
    font-size: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    position: relative;
    width: 32px;
    height: 32px;
    color: #ef4444;
  `;
  
  // Add hover effect
  btn.onmouseenter = () => {
    btn.style.background = '#ef4444';
    btn.style.color = 'white';
    btn.style.transform = 'scale(1.1)';
  };
  btn.onmouseleave = () => {
    btn.style.background = 'white';
    btn.style.color = '#ef4444';
    btn.style.transform = 'scale(1)';
  };
  
  return btn;
}

function createDontBlockButton() {
  const btn = document.createElement("button");
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
  btn.title = "Don't block - Train AI to keep similar content";
  btn.className = "ytd-ai-blocker-btn ytd-ai-dontblock-btn";
  btn.style.cssText = `
    padding: 8px;
    margin-left: 6px;
    border-radius: 6px;
    border: 2px solid #22c55e;
    background: white;
    cursor: pointer;
    font-size: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    position: relative;
    width: 32px;
    height: 32px;
    color: #22c55e;
  `;
  
  // Add hover effect
  btn.onmouseenter = () => {
    btn.style.background = '#22c55e';
    btn.style.color = 'white';
    btn.style.transform = 'scale(1.1)';
  };
  btn.onmouseleave = () => {
    btn.style.background = 'white';
    btn.style.color = '#22c55e';
    btn.style.transform = 'scale(1)';
  };
  
  return btn;
}

function createPlaceholder(matchedTitle, matchedChannel, matchedId, matchedSim, blockReasons = []) {
  const wrapper = document.createElement("div");
  wrapper.className = "ytd-ai-blocker-placeholder";
  wrapper.style.cssText = `
    padding: 16px;
    border: 2px solid #e5e7eb;
    background: linear-gradient(135deg, #ffffff 0%, #f9fafb 100%);
    margin: 8px 0;
    font-size: 13px;
    border-radius: 10px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  `;
  
  // Build reason text
  let reasonText = "";
  if (blockReasons && blockReasons.length > 0) {
    const methods = blockReasons.map(r => `<span style="background:#667eea;color:white;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;margin-right:6px;">${r.method} ${(r.confidence * 100).toFixed(0)}%</span>`).join("");
    reasonText = `<div style="margin-top:8px;">${methods}</div>`;
  }
  
  const unblockBtnHTML = `
    <button class="ai-unblock-btn" style="
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
    " onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 4px 12px rgba(102, 126, 234, 0.5)'" onmouseout="this.style.transform='translateY(0)';this.style.boxShadow='0 2px 8px rgba(102, 126, 234, 0.3)'">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
      Show this
    </button>
  `;
  
  wrapper.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="#ef4444" stroke="#ef4444" stroke-width="2">
        <circle cx="12" cy="12" r="10" fill="none"/>
        <line x1="15" y1="9" x2="9" y2="15"/>
      </svg>
      <span style="font-weight:700;color:#ef4444;font-size:14px;">Blocked by AI</span>
    </div>
    <div style="font-size:12px;color:#6b7280;margin-top:8px;padding:8px;background:#f9fafb;border-radius:6px;">
      <div style="font-weight:600;color:#374151;margin-bottom:4px;">Matched: ${escapeHtml(matchedTitle)}</div>
      <div style="font-size:11px;">Channel: ${escapeHtml(matchedChannel)} • Similarity: ${(matchedSim * 100).toFixed(0)}%</div>
    </div>
    ${reasonText}
    <div style="margin-top:12px;">
      ${unblockBtnHTML}
    </div>
  `;
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
  // don't attach buttons to placeholders
  if (tile.querySelector(".ytd-ai-blocker-placeholder")) return;

  // don't re-process tiles that already have the button
  if (tile.getAttribute("data-ytd-ai-processed") === "true") return;

  // If a previous cloned button exists (from restored content), remove it so we can attach
  // a fresh button with correct event handlers.
  const existingButtons = tile.querySelectorAll(".ytd-ai-blocker-btn");
  existingButtons.forEach(btn => btn.remove());

  // Create Block button
  const blockBtn = createBlockButton();
  blockBtn.onclick = async (e) => {
    e.stopPropagation();
    blockBtn.disabled = true;
    blockBtn.innerText = "Learning...";
    try {
      const { titleText, channelText } = extractVideoInfoFromTile(tile);
      
      console.log(`=== BLOCK CLICKED ===`);
      console.log(`Video: "${titleText}" by "${channelText}"`);
      
      // If this video was previously allowed ("Show this"), remove it from allowed list
      const wasAllowed = allowedItems.find(a => a.title === titleText && a.channel === channelText);
      if (wasAllowed) {
        console.log("This video was previously allowed. Removing from allowed list.");
        removeAllowedItem(titleText, channelText);
      }
      
      const textForEmbed = `${titleText} — ${channelText}`;
      const emb = await embed(textForEmbed);
      
      // Auto-threshold: detect false negatives (user blocking content similar to existing but not auto-caught)
      if (autoThresholdEnabled && blockedItems.length > 0) {
        let maxSim = 0;
        for (const b of blockedItems) {
          const sim = cosineSimilarity(emb, Float32Array.from(b.embedding));
          if (sim > maxSim) maxSim = sim;
        }
        // If somewhat similar to existing blocked items but wasn't auto-blocked → threshold too high
        if (maxSim >= ADAPT_FN_MIN_SIM && maxSim < threshold) {
          console.log(`[Auto-Threshold] FN detected: max sim ${maxSim.toFixed(2)} < threshold ${threshold.toFixed(2)} → lowering threshold`);
          adaptThreshold('down');
        }
      }
      
      const id = addBlockedItem(titleText, channelText, emb);
      // hide tile (wasAutoBlocked = false since user manually blocked)
      hideTileWithPlaceholder(tile, id, titleText, channelText, 1.0 /* local placeholder sim */, [], false);
      console.log("=== BLOCK COMPLETE ===");
    } catch (err) {
      console.error("Block failed", err);
      blockBtn.disabled = false;
      blockBtn.innerText = "Block";
    }
  };

  // Create "Don't block" button
  const dontBlockBtn = createDontBlockButton();
  dontBlockBtn.onclick = async (e) => {
    e.stopPropagation();
    dontBlockBtn.disabled = true;
    dontBlockBtn.innerText = "Adding...";
    try {
      const { titleText, channelText } = extractVideoInfoFromTile(tile);
      const textForEmbed = `${titleText} — ${channelText}`;
      const emb = await embed(textForEmbed);
      addNegativeItem(titleText, channelText, emb);
      dontBlockBtn.innerText = "✓ Added";
      dontBlockBtn.style.background = "#c8e6c9";
      setTimeout(() => {
        dontBlockBtn.disabled = false;
        dontBlockBtn.innerText = "Don't block";
        dontBlockBtn.style.background = "#e8f5e9";
      }, 2000);
    } catch (err) {
      console.error("Don't block failed", err);
      dontBlockBtn.disabled = false;
      dontBlockBtn.innerText = "Don't block";
    }
  };

  // try to insert the buttons in common meta container
  const insertionPoint = tile.querySelector("#meta, #overlays, #details, #content");
  if (insertionPoint) {
    insertionPoint.appendChild(blockBtn);
    insertionPoint.appendChild(dontBlockBtn);
  } else {
    // fallback: append to tile
    tile.appendChild(blockBtn);
    tile.appendChild(dontBlockBtn);
  }

  // Mark as processed to avoid duplicate button attachment
  tile.setAttribute("data-ytd-ai-processed", "true");
}

function hideTileWithPlaceholder(tile, matchedId, matchedTitle, matchedChannel, matchedSim, blockReasons = [], wasAutoBlocked = false) {
  // replace tile's content with placeholder but keep a reference to restore
  const placeholder = createPlaceholder(matchedTitle, matchedChannel, matchedId, matchedSim, blockReasons);
  const originalDisplay = tile.style.display;
  const originalChildren = Array.from(tile.childNodes).map(n => n.cloneNode(true));
  
  // Extract the ACTUAL video info from the tile BEFORE replacing with placeholder
  const { titleText, channelText } = extractVideoInfoFromTile(tile);
  
  tile.innerHTML = "";
  tile.appendChild(placeholder);

  const unblockBtn = placeholder.querySelector(".ai-unblock-btn");

  unblockBtn.addEventListener("click", () => {
    console.log("=== SHOW THIS CLICKED ===");
    console.log("Video info extracted BEFORE placeholder:", titleText, "—", channelText);
    console.log("Matched info from placeholder:", matchedTitle, "—", matchedChannel);

    // Auto-threshold: "Show this" on an auto-blocked video is a false positive → raise threshold
    if (wasAutoBlocked) {
      console.log("[Auto-Threshold] FP detected: user clicked 'Show this' on auto-blocked video → raising threshold");
      adaptThreshold('up');
    }

    // Add to permanently allowed list (using the extracted title/channel)
    addAllowedItem(titleText, channelText);
    
    console.log("Current allowed items after adding:", allowedItems);

    // restore original content
    tile.innerHTML = "";
    for (const n of originalChildren) tile.appendChild(n);
    tile.style.display = originalDisplay;

    // clear the processed flag so the tile can be re-processed
    tile.removeAttribute("data-ytd-ai-processed");

    // ensure UI buttons are re-attached for restored content
    try { attachButtonsToTile(tile); } catch (err) { console.error("Button reattach error:", err); }
    
    console.log("=== SHOW THIS COMPLETE ===");
  });

  // hide tile visually (already replaced by placeholder)
}

/* ---------------- Scanning a tile ---------------- */
async function scanAndMaybeHideTile(tile) {
  try {
    const { titleText, channelText } = extractVideoInfoFromTile(tile);
    
    // skip tiles that already have a placeholder (already processed and blocked)
    if (tile.querySelector(".ytd-ai-blocker-placeholder")) {
      return;
    }

    // ALWAYS go through shouldBlockText - it checks allowed list first
    const res = await shouldBlockText(titleText, channelText);
    if (res.block) {
      // Find the matched item for display purposes
      const matched = blockedItems.find(b => b.title === titleText && b.channel === channelText);
      if (matched) {
        hideTileWithPlaceholder(tile, matched.id, matched.title, matched.channel, 1.0, [], true);
      } else {
        hideTileWithPlaceholder(tile, res.matched?.id || "unknown", res.matched?.title || titleText, res.matched?.channel || channelText, res.sim, res.reasons, true);
      }
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
    if (changes[ALLOWED_KEY]) allowedItems = changes[ALLOWED_KEY].newValue || [];
    if (changes[THRESHOLD_KEY]) {
      const oldThreshold = threshold;
      threshold = changes[THRESHOLD_KEY].newValue || DEFAULT_THRESHOLD;
      console.log("[Content Script] Threshold changed via storage:", oldThreshold, "→", threshold);
      // Re-scan tiles with new threshold
      const tiles = findVideoTiles();
      tiles.forEach(tile => {
        if (tile.offsetParent !== null && !tile.querySelector(".ytd-ai-blocker-placeholder")) {
          scanAndMaybeHideTile(tile).catch(err => console.error("Rescan error:", err));
        }
      });
    }
    if (changes[MODE_KEY]) mode = changes[MODE_KEY].newValue || "local";
    if (changes[BACKEND_KEY]) backendUrl = changes[BACKEND_KEY].newValue || "";
    if (changes[CLASSIFIER_ENABLED_KEY]) {
      classifierEnabled = changes[CLASSIFIER_ENABLED_KEY].newValue || false;
      console.log("[Content Script] Classifier enabled:", classifierEnabled);
    }
    if (changes[CLASSIFIER_KEY]) {
      classifier.fromJSON(changes[CLASSIFIER_KEY].newValue);
      console.log("[Content Script] Classifier updated:", classifier.getStats());
    }
    if (changes[AUTO_THRESHOLD_KEY]) {
      autoThresholdEnabled = changes[AUTO_THRESHOLD_KEY].newValue || false;
      console.log("[Content Script] Auto-threshold enabled:", autoThresholdEnabled);
    }
    if (changes[ADAPT_STATS_KEY]) {
      adaptStats = changes[ADAPT_STATS_KEY].newValue || { up: 0, down: 0 };
    }
  }
});

/* ---------------- Message listener for popup changes ---------------- */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "thresholdChanged") {
    const newThreshold = request.threshold;
    threshold = newThreshold;
    console.log("[Content Script] Threshold updated via message to:", threshold);
    sendResponse({ success: true, threshold: threshold });
    
    // Re-scan all visible tiles with new threshold
    const tiles = findVideoTiles();
    console.log("[Content Script] Re-scanning", tiles.length, "tiles with new threshold", threshold);
    
    tiles.forEach(tile => {
      // Only re-scan tiles that are visible
      if (tile.offsetParent !== null) {
        // Clear placeholder to reset state
        const placeholder = tile.querySelector(".ytd-ai-blocker-placeholder");
        if (placeholder) {
          // Reset the tile data to allow re-scanning
          tile.removeAttribute("data-ytd-ai-processed");
          // Will be re-scanned on next viewport intersection
        }
        // Scan immediately with new threshold
        scanAndMaybeHideTile(tile).catch(err => console.error("Rescan error:", err));
      }
    });
    return true; // Keep channel open for async operations
  }
  
  if (request.action === "retrainClassifier") {
    console.log("[Content Script] Manual classifier retraining requested");
    maybeTrainClassifier()
      .then(stats => {
        if (stats) {
          sendResponse({ 
            success: true, 
            numExamples: stats.numExamples,
            accuracy: stats.accuracy,
            message: `Trained on ${stats.numExamples} examples with ${(stats.accuracy * 100).toFixed(1)}% accuracy`
          });
        } else {
          sendResponse({ 
            success: false, 
            error: "Not enough training data or classifier disabled"
          });
        }
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep channel open for async operations
  }
});

/* ---------------- Bootstrap ---------------- */
(async function bootstrap() {
  try {
    await loadState();
    // Model loading now happens in background worker - no need to wait here
    // initial attach + observe
    startObserving();
    console.log("YouTube AI Blocker content script started. Mode:", mode, "threshold:", threshold);
  } catch (err) {
    console.error("Bootstrap error:", err);
  }
})();
