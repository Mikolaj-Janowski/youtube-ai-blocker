// popup.js (upgraded)
const STORAGE_KEY = "ytd_ai_blocked_items_v2";
const THRESHOLD_KEY = "ytd_ai_threshold_v2";
const CACHE_KEY = "ytd_ai_cache_v2";
const NEGATIVE_KEY = "ytd_ai_negative_v2";
const ALLOWED_KEY = "ytd_ai_allowed_v2";
const MODE_KEY = "ytd_ai_mode_v2";
const BACKEND_KEY = "ytd_ai_backend_v2";
const CLASSIFIER_KEY = "ytd_ai_classifier_v2";
const CLASSIFIER_ENABLED_KEY = "ytd_ai_classifier_enabled_v2";
const AUTO_THRESHOLD_KEY = "ytd_ai_auto_threshold_v2";
const ADAPT_STATS_KEY = "ytd_ai_adapt_stats_v2";
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_MODE = "local";
const MIN_POSITIVES = 10;
const MIN_NEGATIVES = 20;

document.addEventListener("DOMContentLoaded", async () => {
  const blockedList = document.getElementById("blockedList");
  const negativeList = document.getElementById("negativeList");
  const allowedList = document.getElementById("allowedList");
  const clearAllBtn = document.getElementById("clearAll");
  const clearNegativesBtn = document.getElementById("clearNegatives");
  const clearAllowedBtn = document.getElementById("clearAllowed");
  const thresholdInput = document.getElementById("threshold");
  const thVal = document.getElementById("thVal");
  const clearCacheBtn = document.getElementById("clearCache");
  const modeSelect = document.getElementById("mode");
  const backendUrlInput = document.getElementById("backendUrl");
  const backendRow = document.getElementById("backendRow");
  const classifierEnabledCheckbox = document.getElementById("classifierEnabled");
  const classifierStatusDiv = document.getElementById("classifierStatus");
  const retrainClassifierBtn = document.getElementById("retrainClassifier");
  const autoThresholdEnabledCheckbox = document.getElementById("autoThresholdEnabled");
  const adaptiveStatusDiv = document.getElementById("adaptiveStatus");
  const openDashboardBtn = document.getElementById("openDashboard");

  // load settings
  chrome.storage.local.get([
    THRESHOLD_KEY, STORAGE_KEY, NEGATIVE_KEY, ALLOWED_KEY, MODE_KEY, BACKEND_KEY, 
    CLASSIFIER_ENABLED_KEY, CLASSIFIER_KEY, AUTO_THRESHOLD_KEY, ADAPT_STATS_KEY
  ], (data) => {
    const th = data[THRESHOLD_KEY] || DEFAULT_THRESHOLD;
    console.log("Loading threshold from storage:", th);
    thresholdInput.value = th;
    thVal.innerText = th.toFixed(2);
    console.log("Set thVal.innerText to:", th.toFixed(2));
    modeSelect.value = data[MODE_KEY] || DEFAULT_MODE;
    backendUrlInput.value = data[BACKEND_KEY] || "";
    classifierEnabledCheckbox.checked = data[CLASSIFIER_ENABLED_KEY] || false;
    autoThresholdEnabledCheckbox.checked = data[AUTO_THRESHOLD_KEY] || false;
    renderBlocked(data[STORAGE_KEY] || []);
    renderNegatives(data[NEGATIVE_KEY] || []);
    renderAllowed(data[ALLOWED_KEY] || []);
    updateClassifierStatus(data[STORAGE_KEY] || [], data[NEGATIVE_KEY] || [], data[CLASSIFIER_KEY]);
    updateAdaptiveStatus(data[ADAPT_STATS_KEY] || { up: 0, down: 0 });
    backendRow.style.display = (modeSelect.value === "remote") ? "block" : "none";
  });

  thresholdInput.addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    const roundedVal = Math.round(val * 100) / 100;
    console.log("Slider moved. Value:", val, "Rounded:", roundedVal);
    thVal.innerText = roundedVal.toFixed(2);
    console.log("Updated thVal display to:", roundedVal.toFixed(2));
    // Save and broadcast immediately on input
    chrome.storage.local.set({ [THRESHOLD_KEY]: roundedVal }, () => {
      console.log("Threshold saved to storage:", roundedVal);
      // Notify all tabs that threshold changed
      chrome.tabs.query({}, (tabs) => {
        console.log("Queried", tabs.length, "tabs");
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, { action: "thresholdChanged", threshold: roundedVal }).then(() => {
            console.log("Threshold message sent to tab:", tab.id, roundedVal);
          }).catch((err) => {
            console.log("Could not send to tab", tab.id, "(may not have content script)");
          });
        });
      });
    });
  });

  thresholdInput.addEventListener("change", (e) => {
    const v = parseFloat(e.target.value);
    // Ensure it's saved (already saved on input, but do it again for safety)
    chrome.storage.local.set({ [THRESHOLD_KEY]: v });
  });

  modeSelect.addEventListener("change", () => {
    const v = modeSelect.value;
    chrome.storage.local.set({ [MODE_KEY]: v });
    backendRow.style.display = (v === "remote") ? "block" : "none";
  });

  backendUrlInput.addEventListener("change", () => {
    chrome.storage.local.set({ [BACKEND_KEY]: backendUrlInput.value || "" });
  });

  clearAllBtn.addEventListener("click", () => {
    if (!confirm("Clear all blocked items?")) return;
    chrome.storage.local.set({ [STORAGE_KEY]: [] }, () => {
      renderBlocked([]);
    });
  });

  clearNegativesBtn.addEventListener("click", () => {
    if (!confirm("Clear all 'Don't block' items? This will reset classifier training data.")) return;
    chrome.storage.local.set({ [NEGATIVE_KEY]: [] }, () => {
      renderNegatives([]);
    });
  });

  clearAllowedBtn.addEventListener("click", () => {
    if (!confirm("Clear all allowed items? They may be blocked again if they match filters.")) return;
    chrome.storage.local.set({ [ALLOWED_KEY]: [] }, () => {
      renderAllowed([]);
    });
  });

  clearCacheBtn.addEventListener("click", () => {
    if (!confirm("Clear embedding cache?")) return;
    chrome.storage.local.set({ [CACHE_KEY]: {}, [NEGATIVE_KEY]: [] }, () => {
      alert("Cache cleared.");
    });
  });

  openDashboardBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dist/metrics.html") });
  });

  autoThresholdEnabledCheckbox.addEventListener("change", () => {
    const enabled = autoThresholdEnabledCheckbox.checked;
    chrome.storage.local.set({ [AUTO_THRESHOLD_KEY]: enabled }, () => {
      console.log("Auto-threshold enabled:", enabled);
      // Reload adaptive status
      chrome.storage.local.get([ADAPT_STATS_KEY], (data) => {
        updateAdaptiveStatus(data[ADAPT_STATS_KEY] || { up: 0, down: 0 });
      });
    });
  });

  classifierEnabledCheckbox.addEventListener("change", () => {
    const enabled = classifierEnabledCheckbox.checked;
    chrome.storage.local.set({ [CLASSIFIER_ENABLED_KEY]: enabled }, () => {
      console.log("Classifier enabled:", enabled);
      // Reload status
      chrome.storage.local.get([STORAGE_KEY, NEGATIVE_KEY, CLASSIFIER_KEY], (data) => {
        updateClassifierStatus(data[STORAGE_KEY] || [], data[NEGATIVE_KEY] || [], data[CLASSIFIER_KEY]);
      });
    });
  });

  retrainClassifierBtn.addEventListener("click", () => {
    retrainClassifierBtn.disabled = true;
    retrainClassifierBtn.innerText = "Training...";
    
    // Send message to content script to retrain
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "retrainClassifier" }, (response) => {
          retrainClassifierBtn.disabled = false;
          retrainClassifierBtn.innerText = "Retrain Classifier Now";
          
          if (chrome.runtime.lastError) {
            alert("Could not retrain: Make sure you're on a YouTube page.");
            return;
          }
          
          if (response && response.success) {
            alert(response.message || `Trained on ${response.numExamples} examples`);
            // Reload classifier status
            chrome.storage.local.get([STORAGE_KEY, NEGATIVE_KEY, CLASSIFIER_KEY], (data) => {
              updateClassifierStatus(data[STORAGE_KEY] || [], data[NEGATIVE_KEY] || [], data[CLASSIFIER_KEY]);
            });
          } else {
            alert("Training failed: " + (response ? response.error : "Unknown error"));
          }
        });
      }
    });
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes[STORAGE_KEY]) {
      renderBlocked(changes[STORAGE_KEY].newValue || []);
    }
    if (changes[NEGATIVE_KEY]) {
      renderNegatives(changes[NEGATIVE_KEY].newValue || []);
    }
    if (changes[ALLOWED_KEY]) {
      renderAllowed(changes[ALLOWED_KEY].newValue || []);
    }
    // Update classifier status if relevant data changed
    if (changes[STORAGE_KEY] || changes[NEGATIVE_KEY] || changes[CLASSIFIER_KEY]) {
      chrome.storage.local.get([STORAGE_KEY, NEGATIVE_KEY, CLASSIFIER_KEY], (data) => {
        updateClassifierStatus(data[STORAGE_KEY] || [], data[NEGATIVE_KEY] || [], data[CLASSIFIER_KEY]);
      });
    }
    // Sync threshold slider if auto-adaptation changed it from the content script
    if (changes[THRESHOLD_KEY]) {
      const newVal = changes[THRESHOLD_KEY].newValue;
      if (newVal !== undefined) {
        thresholdInput.value = newVal;
        thVal.innerText = parseFloat(newVal).toFixed(2);
      }
    }
    // Update adaptive status when stats change
    if (changes[ADAPT_STATS_KEY]) {
      updateAdaptiveStatus(changes[ADAPT_STATS_KEY].newValue || { up: 0, down: 0 });
    }
  });

  function updateClassifierStatus(blockedItems, negativeItems, classifierData) {
    const numPos = blockedItems.length;
    const numNeg = negativeItems.length;
    
    if (classifierData && classifierData.trainedOn > 0) {
      const lastTrained = classifierData.lastTrained 
        ? new Date(classifierData.lastTrained).toLocaleString()
        : "Unknown";
      classifierStatusDiv.innerHTML = `
        <div style="color: green; font-weight: 600;">✓ Trained on ${classifierData.trainedOn} examples</div>
        <div style="font-size: 11px; color: #666; margin-top: 2px;">Last trained: ${lastTrained}</div>
      `;
    } else if (numPos >= MIN_POSITIVES && numNeg >= MIN_NEGATIVES) {
      classifierStatusDiv.innerHTML = `
        <div style="color: orange; font-weight: 600;">⚠ Ready to train</div>
        <div style="font-size: 11px; color: #666; margin-top: 2px;">
          ${numPos} blocked items, ${numNeg} negative examples
        </div>
      `;
    } else {
      const needPos = Math.max(0, MIN_POSITIVES - numPos);
      const needNeg = Math.max(0, MIN_NEGATIVES - numNeg);
      classifierStatusDiv.innerHTML = `
        <div style="color: #999;">Not enough data</div>
        <div style="font-size: 11px; color: #666; margin-top: 2px;">
          Need ${needPos} more blocked, ${needNeg} more "not similar"
        </div>
      `;
    }
  }

  function updateAdaptiveStatus(stats) {
    const totalUp = stats.up || 0;
    const totalDown = stats.down || 0;
    const total = totalUp + totalDown;
    const isEnabled = autoThresholdEnabledCheckbox.checked;

    if (!isEnabled) {
      adaptiveStatusDiv.innerHTML = `
        <div style="font-size:12px;color:#6b7280;background:#f8f9ff;border:2px solid #e0e4ff;border-radius:8px;padding:12px;line-height:1.6;">
          <div style="font-weight:600;color:#667eea;margin-bottom:6px;">How it works:</div>
          <div>↑ <strong>Raises threshold</strong> when you click "Show this" on auto-blocked videos (false positive)</div>
          <div>↓ <strong>Lowers threshold</strong> when you manually block similar-but-missed content (false negative)</div>
          <div style="margin-top:6px;font-style:italic;color:#9ca3af;">Step size: ±0.02 per event &nbsp;|&nbsp; Range: 0.30 – 0.95</div>
        </div>
      `;
    } else if (total === 0) {
      adaptiveStatusDiv.innerHTML = `
        <div style="font-size:12px;color:#6b7280;background:#f0fdf4;border:2px solid #bbf7d0;border-radius:8px;padding:12px;line-height:1.6;">
          <div style="font-weight:600;color:#16a34a;margin-bottom:4px;">✓ Active — Waiting for feedback</div>
          <div>Browse YouTube and interact with blocked/unblocked videos to start adapting.</div>
        </div>
      `;
    } else {
      adaptiveStatusDiv.innerHTML = `
        <div style="font-size:12px;color:#374151;background:#f0fdf4;border:2px solid #bbf7d0;border-radius:8px;padding:12px;line-height:1.8;">
          <div style="font-weight:600;color:#16a34a;margin-bottom:6px;">✓ Active — Adapted ${total} time${total !== 1 ? 's' : ''}</div>
          <div style="display:flex;gap:16px;">
            <span>↑ Raised: <strong>${totalUp}×</strong></span>
            <span>↓ Lowered: <strong>${totalDown}×</strong></span>
          </div>
          <div style="margin-top:6px;font-size:11px;color:#6b7280;">Current threshold shown in the slider above</div>
        </div>
      `;
    }
  }

  function renderBlocked(items) {
    blockedList.innerHTML = "";
    if (!items || items.length === 0) {
      blockedList.innerText = "(no blocked items yet)";
      return;
    }
    items.forEach(it => {
      const el = document.createElement("div");
      el.className = "blocked-item";
      el.innerHTML = `
        <div>
          <strong>${escapeHtml(it.title)}</strong>
        </div>
        <div class="meta">${escapeHtml(it.channel)}</div>
        <div style="margin-top:6px;">
          <button data-id="${it.id}" class="removeBtn" title="Remove this blocked item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      `;
      blockedList.appendChild(el);
    });
    blockedList.querySelectorAll(".removeBtn").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        chrome.storage.local.get([STORAGE_KEY], (data) => {
          const arr = data[STORAGE_KEY] || [];
          const filtered = arr.filter(x => x.id !== id);
          chrome.storage.local.set({ [STORAGE_KEY]: filtered });
        });
      });
    });
  }

  function renderNegatives(items) {
    negativeList.innerHTML = "";
    if (!items || items.length === 0) {
      negativeList.innerHTML = '<div style="color:#999;font-style:italic;">None (click "Don\'t block" on videos to train the classifier)</div>';
      return;
    }
    items.forEach(it => {
      const el = document.createElement("div");
      el.style.cssText = "padding:6px;border-bottom:1px solid #eee;background:#f1f8f4;";
      el.innerHTML = `<div style="font-weight:500;color:#2e7d32;">${escapeHtml(it.title)}</div><div style="font-size:11px;color:#666;">${escapeHtml(it.channel)}</div>`;
      negativeList.appendChild(el);
    });
  }

  function renderAllowed(items) {
    allowedList.innerHTML = "";
    if (!items || items.length === 0) {
      allowedList.innerHTML = '<div style="color:#999;font-style:italic;">None (click "Show this" on blocked videos to allow them)</div>';
      return;
    }
    items.forEach(it => {
      const el = document.createElement("div");
      el.style.cssText = "padding:6px;border-bottom:1px solid #eee;";
      el.innerHTML = `<div style="font-weight:500;">${escapeHtml(it.title)}</div><div style="font-size:11px;color:#666;">${escapeHtml(it.channel)}</div>`;
      allowedList.appendChild(el);
    });
  }

  function escapeHtml(s) {
    return s ? s.replace(/[&<>"']/g, function(m){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]); }) : "";
  }
});
