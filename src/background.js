// background.js
// Background service worker for embedding via ONNX MiniLM-L6-v2 model
// Uses @xenova/transformers for in-browser neural embeddings

import { pipeline } from "@xenova/transformers";

let extractor = null;
let modelReady = false;

// Load MiniLM-L6-v2 model on startup
async function initModel() {
  if (modelReady) return;
  try {
    console.log("Background: Loading MiniLM-L6-v2 model...");
    
    // Initialize the feature extraction pipeline with MiniLM-L6-v2
    // This uses ONNX Runtime for efficient inference in the browser
    extractor = await pipeline("feature-extraction", "Xenova/MiniLM-L6-v2", {
      quantized: true, // Use quantized version for smaller size
      progress_callback: (progress) => {
        console.log(`Model loading: ${Math.round(progress.progress * 100)}%`);
      }
    });
    
    modelReady = true;
    console.log("Background: MiniLM-L6-v2 model loaded successfully (384-dim embeddings)");
  } catch (err) {
    console.error("Background: Failed to initialize model:", err);
    modelReady = false;
    throw err;
  }
}

// Initialize on load
initModel().catch(err => console.error("Init error:", err));

// Message handler for embedding requests from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "embed") {
    handleEmbed(request.texts)
      .then(sendResponse)
      .catch(err => {
        console.error("Embed error:", err);
        sendResponse({ error: err.message });
      });
    return true; // keep channel open for async response
  }
});

async function handleEmbed(texts) {
  // Ensure model is loaded
  if (!modelReady) {
    console.log("Model not ready, initializing...");
    await initModel();
  }
  
  if (!extractor) {
    throw new Error("Feature extractor not initialized");
  }
  
  try {
    // Extract embeddings for all texts
    // The extractor returns embeddings of shape [batch_size, 384]
    const embeddings = [];
    
    for (const text of texts) {
      // Extract embedding for single text
      const result = await extractor(text, {
        pooling: "mean",
        normalize: true
      });
      
      // Convert tensor to Float32Array
      const embedding = new Float32Array(result.data);
      embeddings.push(Array.from(embedding));
    }
    
    return { embeddings };
  } catch (err) {
    console.error("Error during embedding:", err);
    throw err;
  }
}

console.log("YouTube AI Blocker background worker initialized with ONNX MiniLM-L6-v2");
