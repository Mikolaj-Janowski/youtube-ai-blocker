// offscreen.js
// Offscreen document for ONNX model inference
// Runs in a proper DOM context with full API access (including Atomics.wait)

import { pipeline } from "@xenova/transformers";

let extractor = null;
let modelReady = false;

// Initialize model on load
async function initModel() {
  if (modelReady) return;
  try {
    console.log("Offscreen: Loading MiniLM-L6-v2 model...");
    
    extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      quantized: true,
      progress_callback: (progress) => {
        console.log(`Model loading: ${Math.round(progress.progress * 100)}%`);
      }
    });
    
    modelReady = true;
    console.log("Offscreen: all-MiniLM-L6-v2 model loaded successfully");
  } catch (err) {
    console.error("Offscreen: Failed to initialize model:", err);
    modelReady = false;
    throw err;
  }
}

// Message handler for embedding requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "embed") {
    handleEmbed(request.texts)
      .then(sendResponse)
      .catch(err => {
        console.error("Offscreen embed error:", err);
        sendResponse({ error: err.message });
      });
    return true; // keep channel open for async response
  }
});

async function handleEmbed(texts) {
  // Ensure model is loaded
  if (!modelReady) {
    await initModel();
  }
  
  if (!extractor) {
    throw new Error("Feature extractor not initialized");
  }
  
  try {
    const embeddings = [];
    
    for (const text of texts) {
      const result = await extractor(text, {
        pooling: "mean",
        normalize: true
      });
      
      const embedding = new Float32Array(result.data);
      embeddings.push(Array.from(embedding));
    }
    
    return { embeddings };
  } catch (err) {
    console.error("Error during embedding:", err);
    throw err;
  }
}

// Start initialization
initModel().catch(err => console.error("Init error:", err));

console.log("Offscreen document initialized for model inference");
