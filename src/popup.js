// popup.js (upgraded)
const STORAGE_KEY = "ytd_ai_blocked_items_v2";
const THRESHOLD_KEY = "ytd_ai_threshold_v2";
const CACHE_KEY = "ytd_ai_cache_v2";
const NEGATIVE_KEY = "ytd_ai_negative_v2";
const MODE_KEY = "ytd_ai_mode_v2";
const BACKEND_KEY = "ytd_ai_backend_v2";
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_MODE = "local";

document.addEventListener("DOMContentLoaded", async () => {
  const blockedList = document.getElementById("blockedList");
  const clearAllBtn = document.getElementById("clearAll");
  const thresholdInput = document.getElementById("threshold");
  const thVal = document.getElementById("thVal");
  const clearCacheBtn = document.getElementById("clearCache");
  const modeSelect = document.getElementById("mode");
  const backendUrlInput = document.getElementById("backendUrl");
  const backendRow = document.getElementById("backendRow");

  // load settings
  chrome.storage.local.get([THRESHOLD_KEY, STORAGE_KEY, MODE_KEY, BACKEND_KEY], (data) => {
    const th = data[THRESHOLD_KEY] || DEFAULT_THRESHOLD;
    console.log("Loading threshold from storage:", th);
    thresholdInput.value = th;
    thVal.innerText = th.toFixed(2);
    console.log("Set thVal.innerText to:", th.toFixed(2));
    modeSelect.value = data[MODE_KEY] || DEFAULT_MODE;
    backendUrlInput.value = data[BACKEND_KEY] || "";
    renderBlocked(data[STORAGE_KEY] || []);
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

  chrome.storage.onChanged.addListener((changes) => {
    if (changes[STORAGE_KEY]) {
      renderBlocked(changes[STORAGE_KEY].newValue || []);
    }
  });

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
