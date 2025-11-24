// popup.js
const STORAGE_KEY = "ytd_ai_blocked_items_v1";
const THRESHOLD_KEY = "ytd_ai_threshold_v1";
const DEFAULT_THRESHOLD = 0.82;

document.addEventListener("DOMContentLoaded", async () => {
  const blockedList = document.getElementById("blockedList");
  const clearAllBtn = document.getElementById("clearAll");
  const thresholdInput = document.getElementById("threshold");
  const thVal = document.getElementById("thVal");

  // load threshold
  chrome.storage.local.get([THRESHOLD_KEY, STORAGE_KEY], (data) => {
    const th = data[THRESHOLD_KEY] || DEFAULT_THRESHOLD;
    thresholdInput.value = th;
    thVal.innerText = th;
    renderBlocked(data[STORAGE_KEY] || []);
  });

  thresholdInput.addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    thVal.innerText = v;
  });

  thresholdInput.addEventListener("change", (e) => {
    const v = parseFloat(e.target.value);
    chrome.storage.local.set({ [THRESHOLD_KEY]: v });
  });

  clearAllBtn.addEventListener("click", () => {
    if (!confirm("Clear all blocked items? This will remove saved examples.")) return;
    chrome.storage.local.set({ [STORAGE_KEY]: [] }, () => {
      renderBlocked([]);
    });
  });

  // storage change listener to update popup live
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
    // attach remove handlers
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
