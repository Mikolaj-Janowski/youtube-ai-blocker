// popup.js (upgraded)
const STORAGE_KEY = "ytd_ai_blocked_items_v2";
const THRESHOLD_KEY = "ytd_ai_threshold_v2";
const CACHE_KEY = "ytd_ai_cache_v2";
const NEGATIVE_KEY = "ytd_ai_negative_v2";
const MODE_KEY = "ytd_ai_mode_v2";
const BACKEND_KEY = "ytd_ai_backend_v2";
const CLASSIFIER_KEY = "ytd_ai_classifier_v2";
const CLASSIFIER_ENABLED_KEY = "ytd_ai_classifier_enabled_v2";
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_MODE = "local";
const MIN_POSITIVES = 10;
const MIN_NEGATIVES = 5;

document.addEventListener("DOMContentLoaded", async () => {
  const blockedList = document.getElementById("blockedList");
  const clearAllBtn = document.getElementById("clearAll");
  const thresholdInput = document.getElementById("threshold");
  const thVal = document.getElementById("thVal");
  const clearCacheBtn = document.getElementById("clearCache");
  const modeSelect = document.getElementById("mode");
  const backendUrlInput = document.getElementById("backendUrl");
  const backendRow = document.getElementById("backendRow");
  const classifierEnabledCheckbox = document.getElementById("classifierEnabled");
  const classifierStatusDiv = document.getElementById("classifierStatus");
  const retrainClassifierBtn = document.getElementById("retrainClassifier");

  // load settings
  chrome.storage.local.get([
    THRESHOLD_KEY, STORAGE_KEY, MODE_KEY, BACKEND_KEY, 
    CLASSIFIER_ENABLED_KEY, CLASSIFIER_KEY, NEGATIVE_KEY
  ], (data) => {
    const th = data[THRESHOLD_KEY] || DEFAULT_THRESHOLD;
    console.log("Loading threshold from storage:", th);
    thresholdInput.value = th;
    thVal.innerText = th.toFixed(2);
    console.log("Set thVal.innerText to:", th.toFixed(2));
    modeSelect.value = data[MODE_KEY] || DEFAULT_MODE;
    backendUrlInput.value = data[BACKEND_KEY] || "";
    classifierEnabledCheckbox.checked = data[CLASSIFIER_ENABLED_KEY] || false;
    renderBlocked(data[STORAGE_KEY] || []);
    updateClassifierStatus(data[STORAGE_KEY] || [], data[NEGATIVE_KEY] || [], data[CLASSIFIER_KEY]);
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

  clearCacheBtn.addEventListener("click", () => {
    if (!confirm("Clear embedding cache?")) return;
    chrome.storage.local.set({ [CACHE_KEY]: {}, [NEGATIVE_KEY]: [] }, () => {
      alert("Cache cleared.");
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
    // Update classifier status if relevant data changed
    if (changes[STORAGE_KEY] || changes[NEGATIVE_KEY] || changes[CLASSIFIER_KEY]) {
      chrome.storage.local.get([STORAGE_KEY, NEGATIVE_KEY, CLASSIFIER_KEY], (data) => {
        updateClassifierStatus(data[STORAGE_KEY] || [], data[NEGATIVE_KEY] || [], data[CLASSIFIER_KEY]);
      });
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

  function renderBlocked(items) {
    blockedList.innerHTML = "";
    if (!items || items.length === 0) {
      blockedList.innerText = "(no blocked items yet)";
      return;
    }
    items.forEach(it => {
      const el = document.createElement("div");
      el.className = "blocked-item";
      el.innerHTML = `<div><strong>${escapeHtml(it.title)}</strong></div><div class="meta">${escapeHtml(it.channel)}</div><div style="margin-top:6px;"><button data-id="${it.id}" class="removeBtn">Remove</button></div>`;
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

  function escapeHtml(s) {
    return s ? s.replace(/[&<>"']/g, function(m){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]); }) : "";
  }
});
