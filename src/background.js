// background.js
// Background service worker that manages the offscreen document for model inference
// Offscreen documents have full API access needed for ONNX Runtime

let offscreenReady = false;

// Create and manage offscreen document
async function ensureOffscreenDocument() {
  if (offscreenReady) return;
  
  // Check if offscreen document already exists
  const clients = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  
  if (clients.length === 0) {
    // Create offscreen document if it doesn't exist
    try {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL('dist/offscreen.html'),
        reasons: ['WORKERS'],
        justification: 'ONNX Runtime uses Web Workers for WebAssembly inference'
      });
      console.log("Background: Offscreen document created");
    } catch (err) {
      console.error("Background: Failed to create offscreen document:", err);
      throw err;
    }
  }
  
  offscreenReady = true;
}

// Initialize offscreen on startup
ensureOffscreenDocument().catch(err => console.error("Offscreen init error:", err));

// Message handler for embedding requests from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "embed") {
    // Delegate to offscreen document
    ensureOffscreenDocument()
      .then(() => {
        chrome.runtime.sendMessage({ action: "embed", texts: request.texts }, sendResponse);
      })
      .catch(err => {
        console.error("Embed error:", err);
        sendResponse({ error: err.message });
      });
    return true; // keep channel open for async response
  }
});

console.log("YouTube AI Blocker background worker initialized");
