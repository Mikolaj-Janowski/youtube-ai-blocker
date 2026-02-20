# Code Documentation

**Project:** YouTube AI Blocker  
**Version:** 0.3.7  
**Date:** February 19, 2026  

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Message Passing API](#3-message-passing-api)
4. [Storage Schema](#4-storage-schema)
5. [Content Script API](#5-content-script-api-content_scriptjs)
6. [Classifier Module API](#6-classifier-module-api-classifierjs)
7. [Background Worker API](#7-background-worker-api-backgroundjs)
8. [Offscreen Worker API](#8-offscreen-worker-api-offscreenjs)
9. [Popup API](#9-popup-api-popupjs)
10. [Metrics System](#10-metrics-system)
11. [Constants Reference](#11-constants-reference)

---

## 1. Architecture Overview

The extension is split into four isolated execution contexts that communicate via Chrome's message passing system:

```
┌───────────────────────────────────────────────────────────────────────┐
│                          YouTube Page (DOM)                            │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │            content_script.js  (injected context)                │  │
│  │                                                                  │  │
│  │  • MutationObserver + IntersectionObserver – tile detection     │  │
│  │  • shouldBlockText()  – hybrid blocking decision                 │  │
│  │  • hideTileWithPlaceholder() – DOM manipulation                 │  │
│  │  • adaptThreshold()   – automatic threshold adaptation          │  │
│  │  • recordMetricEvent() – TP / FP / FN counters                  │  │
│  │  • imports LogisticRegressionClassifier from classifier.js      │  │
│  └──────────────────────────┬────────────────────────────────────┘  │
└─────────────────────────────┼──────────────────────────────────────┘
                              │ chrome.runtime.sendMessage
                              │ { action: "embed", texts: [...] }
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│          background.js  (Service Worker – persistent)                │
│                                                                      │
│  • Receives embed requests from content script                       │
│  • Ensures offscreen document is alive                               │
│  • Forwards embed request to offscreen document                      │
│  • Returns embeddings back to content script                         │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ chrome.runtime.sendMessage
                               │ { action: "embed", texts: [...] }
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│          offscreen.js  (Offscreen Document – ONNX worker)            │
│                                                                      │
│  • Has full API access (Atomics.wait allowed here)                   │
│  • Loads Xenova/all-MiniLM-L6-v2 ONNX model from dist/models/       │
│  • Runs tokenisation → mean pooling → L2 normalisation               │
│  • Returns float32 embedding arrays (384 dimensions)                 │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│          popup.html / popup.js  (Popup UI)                           │
│                                                                      │
│  • Reads/writes settings via chrome.storage.local                    │
│  • Displays blocked / don't-block / allowed lists                    │
│  • Controls: threshold slider, classifier toggle, adapt toggle       │
│  • Opens metrics.html dashboard in a new tab                         │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│          dist/metrics.html / metrics.js  (Dashboard Tab)             │
│                                                                      │
│  • Reads ytd_ai_metrics_v2 from chrome.storage.local                 │
│  • Calculates Precision / Recall / F1 from raw counters              │
│  • Renders SVG longitudinal chart from history snapshots             │
│  • Provides CSV export and metrics reset                             │
└─────────────────────────────────────────────────────────────────────┘

                    ↕  All components read/write via
┌─────────────────────────────────────────────────────────────────────┐
│                     chrome.storage.local                             │
│  (See Section 4 for full schema)                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Why an Offscreen Document?

ONNX Runtime's WebAssembly backend requires `Atomics.wait()`, which is deliberately blocked in:
- Content scripts (cross-origin security)
- Service workers (Manifest V3 restriction)

Offscreen documents (a Manifest V3 primitive) run in a hidden browser context with full DOM and `SharedArrayBuffer` access, making them the only viable host for synchronous WASM execution in MV3.

---

## 2. File Structure

```
youtube-ai-blocker/
├── src/
│   ├── content_script.js   Main injection – filtering, metrics, adaptation
│   ├── classifier.js       LogisticRegressionClassifier class + helpers
│   ├── background.js       Service worker – embed request router
│   ├── offscreen.js        ONNX inference host
│   ├── offscreen.html      Offscreen document shell
│   ├── popup.html          Extension popup (600 px wide)
│   ├── popup.js            Popup controller logic
│   ├── metrics.html        Metrics dashboard page
│   ├── metrics.js          Dashboard controller logic
│   ├── styles.css          Shared styles for popup + video tile buttons
│   └── models/
│       └── all-minilm-l6-v2/
│           ├── config.json
│           ├── model.onnx       (quantised INT8, ~23 MB)
│           └── tokenizer.json
├── dist/                   Build output (loaded by Chrome)
├── manifest.json           MV3 extension manifest
├── package.json            Build scripts (esbuild)
└── download-model.js       Model download helper
```

---

## 3. Message Passing API

All messages use `chrome.runtime.sendMessage` with an `action` discriminator field.

### 3.1 content_script → background

#### `embed`
Request text embeddings from the local ONNX model.

| Field | Type | Description |
|-------|------|-------------|
| `action` | `"embed"` | Message discriminator |
| `texts` | `string[]` | Array of strings to embed (max `EMBED_BATCH_SIZE = 8`) |

**Response:**

| Field | Type | Description |
|-------|------|-------------|
| `embeddings` | `number[][]` | Array of 384-element float arrays |
| `error` | `string?` | Error message if inference failed |

**Example:**
```javascript
chrome.runtime.sendMessage(
  { action: "embed", texts: ["Fortnite Gameplay — SomeChannel"] },
  (response) => {
    if (response.error) throw new Error(response.error);
    const embedding = Float32Array.from(response.embeddings[0]); // 384 floats
  }
);
```

---

### 3.2 background → offscreen

Background forwards the same `embed` message format directly to the offscreen document.

| Field | Type | Description |
|-------|------|-------------|
| `action` | `"embed"` | Same message discriminator |
| `texts` | `string[]` | Forwarded verbatim from content script |

The offscreen document responds with the same `{ embeddings }` / `{ error }` shape.

---

## 4. Storage Schema

All data is stored in `chrome.storage.local`. Keys and their TypeScript-like types:

| Storage Key | Type | Default | Description |
|-------------|------|---------|-------------|
| `ytd_ai_blocked_items_v2` | `BlockedItem[]` | `[]` | Positive training examples |
| `ytd_ai_negative_v2` | `BlockedItem[]` | `[]` | Negative training examples ("Don't Block") |
| `ytd_ai_allowed_v2` | `AllowedItem[]` | `[]` | Permanent allow list ("Show this") |
| `ytd_ai_classifier_v2` | `ClassifierJSON \| null` | `null` | Serialised logistic regression model |
| `ytd_ai_classifier_enabled_v2` | `boolean` | `false` | Whether to run classifier predictions |
| `ytd_ai_cache_v2` | `Record<string, number[]>` | `{}` | Text → embedding array (persistent) |
| `ytd_ai_threshold_v2` | `number` | `0.7` | Similarity + classifier decision threshold |
| `ytd_ai_mode_v2` | `"local" \| "remote"` | `"local"` | Embedding inference mode |
| `ytd_ai_backend_v2` | `string` | `""` | Remote backend base URL |
| `ytd_ai_auto_threshold_v2` | `boolean` | `false` | Whether threshold adapts automatically |
| `ytd_ai_adapt_stats_v2` | `AdaptStats` | `{up:0,down:0}` | Cumulative adaptation counters |
| `ytd_ai_metrics_v2` | `MetricsData` | see below | Quantitative performance metrics |

### Type Definitions

```typescript
interface BlockedItem {
  id: string;          // "blocked_<timestamp>_<rand>" or "neg_<timestamp>_<rand>"
  title: string;       // Video title
  channel: string;     // Channel name (or "unknown channel")
  embedding: number[]; // 384-element float array
}

interface AllowedItem {
  id: string;          // "allow_<timestamp>_<rand>"
  title: string;
  channel: string;
  timestamp: number;   // Unix ms
}

interface ClassifierJSON {
  weights: number[] | null;  // 384 floats
  bias: number;
  trainedOn: number;         // Example count at last training
  embeddingDim: number;      // Always 384
  lastTrained: number | null; // Unix ms
  version: number;           // Model schema version
}

interface AdaptStats {
  up: number;    // Times threshold was raised (FP detected)
  down: number;  // Times threshold was lowered (FN detected)
}

interface MetricsSnapshot {
  timestamp: number;
  totalAutoBlocked: number;
  falsePositives: number;
  falseNegatives: number;
  threshold: number;
  precision: number | null;  // null when auto = 0
  recall: number | null;     // null when tp + fn = 0
  f1: number | null;
}

interface MetricsData {
  totalAutoBlocked: number;   // Cumulative AI-hidden count
  falsePositives: number;     // "Show this" on AI-blocked video
  falseNegatives: number;     // Manual block of missed similar content
  totalManualBlocked: number; // Cumulative manual "Block" clicks
  sessionStart: number;       // Unix ms when storage was first created
  history: MetricsSnapshot[]; // Up to 100 snapshots
}
```

---

## 5. Content Script API (`content_script.js`)

The content script is a single module bundled to `dist/content_script.js`. It is injected into every `https://www.youtube.com/*` page.

### 5.1 Initialisation

```
Page load
  └─ loadState()           — reads all keys from chrome.storage.local
      └─ scanAllTiles()    — processes every tile already on the page
          └─ attachButtons() on each tile
```

A `MutationObserver` (debounced 220 ms) watches for DOM changes and calls `scanAllTiles()` again. An `IntersectionObserver` ensures only viewport-visible tiles are processed for embeddings.

---

### 5.2 Key Functions

#### `loadState() → Promise<void>`
Reads all storage keys and populates module-level globals. Called once on startup.

---

#### `saveToStorage(keys: Record<string, any>) → void`
Writes an object of key→value pairs to `chrome.storage.local`. All writes are fire-and-forget.

---

#### `embed(text: string) → Promise<Float32Array>`
Returns a 384-dimensional L2-normalised embedding for `text`.

1. Checks `runtimeCache` (in-memory `Map`) first — O(1).
2. Falls back to `cache` (persistent JSON from storage).
3. Otherwise queues a batch embed request. When `embedQueue.length >= 8` or after 80 ms, `processEmbedQueue()` fires the batch request to the background worker.

Cache key is normalised: `text.trim().replace(/\s+/g,' ').toLowerCase()`.

---

#### `shouldBlockText(title: string, channel: string) → Promise<BlockResult>`
Core hybrid blocking decision. Returns:

```typescript
type BlockResult =
  | { block: false }
  | { block: false; reason: "explicitly_allowed" }
  | {
      block: true;
      reasons: BlockReason[];
      matched: BlockedItem | null;
      sim: number;      // highest cosine similarity seen
      numMethods: number;
    };

interface BlockReason {
  method: "similarity" | "classifier";
  confidence: number;
  matched?: BlockedItem;  // only for similarity
}
```

**Decision flow:**
1. If `title + channel` is in `allowedItems` → return `{ block: false }` unconditionally.
2. Embed the text `"<title> — <channel>"`.
3. Compute cosine similarity against every item in `blockedItems`. If any `>= threshold` → add similarity `BlockReason`.
4. If `classifierEnabled` and `classifier.isReady()` → call `classifier.predict(emb)`. If `>= threshold` → add classifier `BlockReason`.
5. If any reasons → `{ block: true, … }`. Otherwise `{ block: false }`.

---

#### `addBlockedItem(title, channel, embedding) → string`
Pushes a new entry to `blockedItems`, persists to storage, schedules `maybeTrainClassifier()` in 100 ms. Returns the new item's `id`.

---

#### `addNegativeItem(title, channel, embedding) → string`
Same as `addBlockedItem` but pushes to `negativeItems`. Triggers classifier retraining.

---

#### `addAllowedItem(title, channel) → string`
Adds an entry to `allowedItems`. This takes absolute priority in `shouldBlockText`. Does **not** store an embedding — identity comparison is used.

---

#### `removeAllowedItem(title, channel) → void`
Removes the matching entry from `allowedItems` and persists. Called by `addBlockedItem` so manually blocking a previously-allowed video reinstates filtering.

---

#### `maybeTrainClassifier() → Promise<TrainingStats | null>`
Trains (or re-trains from scratch) the logistic regression classifier if:
- `classifierEnabled === true`
- `blockedItems.length >= MIN_POSITIVES_FOR_TRAINING` (10)
- `negativeItems.length >= MIN_NEGATIVES_FOR_TRAINING` (20)

Dataset balancing: if class ratio > 2:1, the majority class is undersampled to 1:1.

Training calls `classifier.train(X, y, 150, true)` then persists the model via `saveToStorage`.

---

#### `adaptThreshold(direction: 'up' | 'down') → void`
Adjusts the global `threshold` by `ADAPT_STEP` (0.02) in the given direction, clamped to `[ADAPT_FLOOR, ADAPT_CEILING]` = `[0.30, 0.95]`.

Only executes if `autoThresholdEnabled === true`. Saves both the new `threshold` and updated `adaptStats` to storage (which triggers the popup slider to update via `onChanged` listener).

**Called by:**
- `hideTileWithPlaceholder` "Show this" handler → `adaptThreshold('up')` (false positive)
- Block button handler → `adaptThreshold('down')` when max similarity to existing blocked items `>= ADAPT_FN_MIN_SIM` (0.40) (false negative)

---

#### `recordMetricEvent(event: MetricEventType) → void`
Increments the appropriate counter in `metricsData` and persists. Takes a snapshot every `SNAPSHOT_INTERVAL` (10) auto-blocks.

```typescript
type MetricEventType =
  | 'auto_blocked'    // tile hidden automatically by AI
  | 'false_positive'  // "Show this" on an auto-blocked tile
  | 'false_negative'  // manual block of missed content
  | 'manual_blocked'  // any manual "Block" button click
```

---

#### `hideTileWithPlaceholder(tile, info, blockInfo, wasAutoBlocked) → void`
Replaces a video tile with a styled placeholder div. The placeholder shows:
- Video title and channel
- Highest similarity score
- Which method(s) triggered the block (e.g. "similarity (82%) + classifier (79%)")
- A "Show this" button

The "Show this" button:
1. Adds the video to `allowedItems`.
2. Adds the tile element's id to `recentlyUnblocked` (30-second grace period to prevent re-block).
3. Calls `adaptThreshold('up')` if `wasAutoBlocked === true`.
4. Calls `recordMetricEvent('false_positive')` if `wasAutoBlocked === true`.
5. Restores the original tile DOM.

---

#### `scanAndMaybeHideTile(tile) → Promise<void>`
Main per-tile processing function:
1. Extracts `{ title, channel }` from the tile's DOM.
2. Skips if `recentlyUnblocked` contains this tile.
3. Attaches "Block" / "Don't Block" icon buttons if not already present.
4. Calls `shouldBlockText(title, channel)`.
5. If blocked → calls `hideTileWithPlaceholder(tile, info, blockInfo, wasAutoBlocked=true)` and `recordMetricEvent('auto_blocked')`.

---

### 5.3 Storage Change Listener

`chrome.storage.onChanged` listener syncs the following keys live:

| Changed Key | Action |
|-------------|--------|
| `STORAGE_KEY` | Reload `blockedItems`, re-scan tiles |
| `NEGATIVE_KEY` | Reload `negativeItems` |
| `ALLOWED_KEY` | Reload `allowedItems` |
| `THRESHOLD_KEY` | Update `threshold`, re-scan all tiles |
| `CLASSIFIER_KEY` | Reload classifier weights |
| `CLASSIFIER_ENABLED_KEY` | Update flag |
| `AUTO_THRESHOLD_KEY` | Update `autoThresholdEnabled` |
| `ADAPT_STATS_KEY` | Update `adaptStats` |
| `METRICS_KEY` | Update `metricsData` |

---

## 6. Classifier Module API (`classifier.js`)

Exported as an ES module, bundled into `content_script.js` via esbuild.

### 6.1 `LogisticRegressionClassifier` (class)

#### Constructor
```javascript
const clf = new LogisticRegressionClassifier();
```

Default hyperparameters:
- `learningRate = 0.01`
- `regularization = 0.001` (overridden to `0.0001` before training in `maybeTrainClassifier`)
- `embeddingDim = 384`

---

#### `train(X, y, epochs?, verbose?) → TrainingStats`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `X` | `Float32Array[]` | — | Training embeddings |
| `y` | `number[]` | — | Labels: `1` = block, `0` = allow |
| `epochs` | `number` | `100` | Gradient descent iterations |
| `verbose` | `boolean` | `false` | Log every 20th epoch |

Returns:
```typescript
{
  finalLoss: number;   // Binary cross-entropy at last epoch
  accuracy: number;    // Training-set accuracy [0, 1]
  epochs: number;
  numExamples: number;
}
```

Initialises weights from `Uniform(−0.005, 0.005)`. Uses stochastic gradient descent with L2 regularisation. Data is shuffled each epoch using Fisher-Yates.

---

#### `predict(embedding: Float32Array) → number`
Returns `P(block | embedding)` ∈ `[0, 1]`.

Computation: `sigmoid(w · x + b)`

Throws `Error("Classifier not trained yet")` if `weights === null`.

---

#### `update(embedding, label, iterations?) → void`
Online update (incremental gradient steps) for a single example. Used to add new evidence without full retraining. Not currently called in the main flow but available.

---

#### `isReady() → boolean`
Returns `true` if `weights !== null && trainedOn > 0`.

---

#### `toJSON() → ClassifierJSON`
Serialises model to a plain object for `chrome.storage.local`.

---

#### `fromJSON(data: ClassifierJSON) → void`
Deserialises model from storage. Sets `weights` as a `Float32Array`.

---

#### `getStats() → ClassifierStats`
```typescript
{
  ready: boolean;
  trainedOn: number;
  lastTrained: number | null;
  version: number;
  parameterCount: number;  // weights.length + 1 (for bias)
}
```

---

### 6.2 Exported Helper Functions

#### `balanceDataset(X, y) → { X, y }`
Undersamples the majority class to achieve a 1:1 class ratio. Uses Fisher-Yates shuffle.

#### `evaluateClassifier(classifier, X, y, threshold?) → EvalMetrics`
Computes full binary classification metrics on a held-out set:
```typescript
{ accuracy, precision, recall, f1, tp, fp, tn, fn }
```
`threshold` defaults to `0.5`.

---

## 7. Background Worker API (`background.js`)

The service worker is thin — its sole purpose is routing embed requests to the offscreen document.

#### `ensureOffscreenDocument() → Promise<void>`
Creates the offscreen document at `dist/offscreen.html` if it does not already exist. Called once on startup and before every embed request. Idempotent.

#### Message listener (action: `"embed"`)
Calls `ensureOffscreenDocument()`, then forwards the message to the offscreen document with `chrome.runtime.sendMessage`. The `return true` in the listener keeps the async channel open.

---

## 8. Offscreen Worker API (`offscreen.js`)

Runs in the hidden offscreen document context.

#### Startup
Calls `pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { ... })` with `localModelPath` pointing to `dist/models/all-minilm-l6-v2/`. A progress callback logs model loading percentages to the console.

#### Message listener (action: `"embed"`)
| Step | Operation |
|------|-----------|
| 1 | Run model on `request.texts` with `pooling: 'mean'`, `normalize: true` |
| 2 | Extract float data from the tensor output |
| 3 | `sendResponse({ embeddings: [...] })` |

Returns a **384-dimensional L2-normalised float32 array** per input string.

---

## 9. Popup API (`popup.js`)

### 9.1 State Loading

On `DOMContentLoaded`, reads all storage keys and:
- Sets the threshold slider value and label
- Sets mode radio buttons
- Sets classifier enable checkbox
- Sets adaptive threshold toggle
- Calls `renderLists()` for blocked / negative / allowed items
- Calls `updateAdaptiveStatus()`

### 9.2 Key Functions

#### `renderLists(blocked, negative, allowed) → void`
Renders three `<ul>` elements in the popup. Each item gets a remove icon button. Counts are shown in section headers.

#### `updateAdaptiveStatus(enabled, stats) → void`
Updates the `#adaptiveStatus` span:
- Toggle off → `"Off"`
- Toggle on, `stats.up + stats.down === 0` → `"Active — waiting for data"`
- Toggle on, otherwise → `"Active — adapted N times"`

#### `updateSliderBackground(slider) → void`
Updates the CSS `--slider-progress` variable on the slider to fill the track gradient proportionally.

### 9.3 Storage Change Listener
The popup listens to `chrome.storage.onChanged` and live-updates:
- Threshold slider + label when `THRESHOLD_KEY` changes (auto-adaptation)
- `adaptStats` display when `ADAPT_STATS_KEY` changes
- Blocked / negative / allowed lists when their respective keys change

### 9.4 Controls

| Element ID | Type | Action |
|------------|------|--------|
| `thresholdSlider` | Range `[0.01, 1.00]` step `0.01` | Saves threshold, triggers re-scan |
| `classifierEnabledCheckbox` | Checkbox | Saves classifier enabled state |
| `retrainBtn` | Button | Sends `{ action: "retrainClassifier" }` to content script |
| `autoThresholdEnabledCheckbox` | Toggle | Saves auto-threshold state |
| `openDashboardBtn` | Button | `chrome.tabs.create({ url: "dist/metrics.html" })` |
| `clearBlockedBtn` | Button | Clears `STORAGE_KEY`, reloads list |
| `clearNegativeBtn` | Button | Clears `NEGATIVE_KEY`, reloads list |
| `clearAllowedBtn` | Button | Clears `ALLOWED_KEY`, reloads list |
| `clearCacheBtn` | Button | Clears `CACHE_KEY` |

---

## 10. Metrics System

### 10.1 Event Types

| Event | When fired | Effect |
|-------|-----------|--------|
| `auto_blocked` | Every tile hidden by AI | `totalAutoBlocked++`; snapshot if `% 10 === 0` |
| `false_positive` | "Show this" on AI-blocked tile | `falsePositives++` |
| `false_negative` | Manual block where `maxSim >= 0.40` to existing items | `falseNegatives++` |
| `manual_blocked` | Every "Block" button click | `totalManualBlocked++` |

### 10.2 Metric Formulas

```
TP = totalAutoBlocked − falsePositives
FP = falsePositives
FN = falseNegatives

Precision = TP / (TP + FP)  =  TP / totalAutoBlocked
Recall    = TP / (TP + FN)
F1        = 2 × Precision × Recall / (Precision + Recall)
```

> **Note on TP definition:** Every auto-block that the user does not correct is treated as a True Positive. This is an optimistic approximation — the user may not have noticed the block — but it is the standard proxy metric for implicit-feedback systems.

### 10.3 Snapshot System

`takeMetricsSnapshot()` is called automatically every `SNAPSHOT_INTERVAL = 10` auto-blocks. Each snapshot contains:
```typescript
{
  timestamp, totalAutoBlocked, falsePositives, falseNegatives,
  threshold, precision, recall, f1
}
```
A rolling buffer of the **last 100 snapshots** is kept. Older entries are dropped.

### 10.4 Metrics Dashboard (`metrics.js`)

The dashboard page is opened as a full browser tab. It:
1. Reads `ytd_ai_metrics_v2` from `chrome.storage.local`.
2. Calculates current P/R/F1 from raw counters.
3. Renders animated CSS progress bars for P/R/F1.
4. Draws an **inline SVG line chart** for longitudinal P/R/F1 (no external dependencies).
5. Computes an **Early vs Recent F1** comparison: average of first 3 snapshots vs. last 3.
6. Populates a sortable HTML table of all snapshots.
7. Listens to `chrome.storage.onChanged` and refreshes automatically.

**CSV export format:**
```
timestamp,totalAutoBlocked,falsePositives,falseNegatives,threshold,precision,recall,f1
1708350000000,50,3,2,0.74,0.94,0.96,0.95
...
```

---

## 11. Constants Reference

### content_script.js

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_THRESHOLD` | `0.7` | Initial cosine similarity cutoff |
| `EMBED_BATCH_SIZE` | `8` | Max texts per embedding batch |
| `MIN_POSITIVES_FOR_TRAINING` | `10` | Blocked items needed to train classifier |
| `MIN_NEGATIVES_FOR_TRAINING` | `20` | "Don't Block" items needed to train classifier |
| `ADAPT_STEP` | `0.02` | Threshold change per adaptation event |
| `ADAPT_FLOOR` | `0.30` | Minimum allowed threshold |
| `ADAPT_CEILING` | `0.95` | Maximum allowed threshold |
| `ADAPT_FN_MIN_SIM` | `0.40` | Min similarity to trigger false-negative detection |
| `SNAPSHOT_INTERVAL` | `10` | Auto-blocks between performance snapshots |

### classifier.js

| Constant | Value | Description |
|----------|-------|-------------|
| `learningRate` | `0.01` | SGD step size (instance property) |
| `regularization` | `0.001` (default) / `0.0001` (overridden at train time) | L2 penalty |
| `embeddingDim` | `384` | MiniLM-L6-v2 output size |
| `epochs` (train call) | `150` | Training iterations |

---

*For user-facing documentation, see [README.md](README.md).*  
*For feature history, see [WHATS_NEW_v0.3.0.md](WHATS_NEW_v0.3.0.md).*  
*For project status, see [PROJECT_CHECKLIST.md](PROJECT_CHECKLIST.md).*

