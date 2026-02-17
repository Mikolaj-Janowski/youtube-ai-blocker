# YouTube AI Blocker

An AI-powered browser extension for intelligent, adaptive content filtering on YouTube. This extension learns from your preferences to automatically hide videos similar to content you've blocked, using state-of-the-art natural language processing.

![Version](https://img.shields.io/badge/version-0.2.0-blue)
![Manifest](https://img.shields.io/badge/manifest-v3-green)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## Overview

YouTube AI Blocker is an academic research project that demonstrates how AI can enhance user autonomy and control over digital content. Unlike traditional keyword-based filters, this extension uses **semantic understanding** to learn what types of content you want to avoid.

### Key Features

- **AI-Powered Filtering**: Uses MiniLM-L6-v2 transformer model for semantic similarity
- **Privacy-First**: All processing happens locally in your browser
- **Learns from You**: Adapts based on your blocking decisions
- **Real-Time**: Automatically filters content as you browse
- **Adjustable**: Fine-tune sensitivity with threshold slider
- **Reversible**: Undo mistakes with "Show this" button
- **Negative Feedback**: Mark false positives as "Not similar"
- **Dual Mode**: Local ONNX inference or optional remote backend

---

## Table of Contents

- [How It Works](#how-it-works)
- [Installation](#installation)
- [Usage](#usage)
- [Architecture](#architecture)
- [Technical Details](#technical-details)
- [Configuration](#configuration)
- [Development](#development)
- [Academic Context](#academic-context)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

---

## How It Works

### 1. **You Block Content**
Click the "Block" button on any YouTube video. The extension captures the video's title and channel name.

### 2. **AI Creates Understanding**
The MiniLM-L6-v2 model converts the text into a 384-dimensional vector embedding that captures semantic meaning.

### 3. **Automatic Filtering**
As you browse, the extension:
- Extracts metadata from each video
- Computes embeddings for new content
- Calculates cosine similarity with blocked items
- Hides videos that exceed the similarity threshold

### 4. **Continuous Learning**
- **Positive Examples**: Videos you block teach the system what to filter
- **Negative Examples**: "Not similar" feedback prevents false positives
- **Threshold Adjustment**: Real-time sensitivity control

### Why This Matters

Traditional filters use simple keyword matching (e.g., block "politics"). This extension understands **meaning**:
- Blocks "Election Results 2024" and "Campaign Rally Highlights" if you block "Presidential Debate"
- Distinguishes "Python Tutorial" from "Python Snake Documentary"
- Adapts to nuanced preferences without explicit rules

---

## Installation

### Prerequisites
- Google Chrome or Chromium-based browser (Edge, Brave, etc.)
- Node.js and npm (for building from source)

### Option 1: Install from Source (Recommended)

1. **Clone the repository**
```bash
git clone https://github.com/Mikolaj-Janowski/youtube-ai-blocker.git
cd youtube-ai-blocker
```

2. **Install dependencies**
```bash
npm install
```

3. **Download the AI model**
```bash
node download-model.js
```

4. **Build the extension**
```bash
npm run build
```

5. **Load in Chrome**
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" (top right)
   - Click "Load unpacked"
   - Select the `dist/` folder in the project directory

### Option 2: Install Pre-built Package

*(Coming soon - will be available after academic evaluation)*

---

## Usage

### Basic Workflow

1. **Visit YouTube**
   - Go to youtube.com
   - Browse homepage, search results, or any page with videos

2. **Block Unwanted Content**
   - Each video tile has a "Block" button
   - Click it on content you want to filter
   - The button shows "Learning..." while processing
   - The video is immediately hidden

3. **Automatic Filtering**
   - Similar videos are automatically hidden as you browse
   - A placeholder shows why each video was blocked
   - The matched item and similarity score are displayed

4. **Review and Correct**
   - If a video was incorrectly blocked:
     - Click "Show this" to restore it
     - Click "Not similar" to teach the system it's different

5. **Adjust Sensitivity**
   - Click the extension icon in toolbar
   - Move the threshold slider:
     - **Lower** (0.5-0.7): More aggressive filtering
     - **Higher** (0.7-0.9): More conservative filtering
   - Changes apply immediately

### Advanced Features

#### Managing Blocked Items
- Open the extension popup
- View all blocked items with titles and channels
- Remove individual items by clicking "Remove"
- Clear all blocks with "Clear All Blocks"

#### Cache Management
- Embeddings are cached to improve performance
- Clear cache if you want to reset all learned patterns
- Cache automatically rebuilds as you block new content

#### Remote Backend Mode
- For faster inference or shared filtering across devices
- Set mode to "Remote" in popup
- Enter your backend API URL
- Backend must implement POST `/embed` endpoint

---

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                         YouTube Page                         │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Content Script (content_script.js)         │ │
│  │  • Observes DOM for video tiles                         │ │
│  │  • Extracts metadata (title, channel)                   │ │
│  │  • Adds "Block" buttons                                 │ │
│  │  • Hides filtered content                               │ │
│  │  • Manages placeholders and undo                        │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            ↕ Message Passing
┌─────────────────────────────────────────────────────────────┐
│              Background Service Worker (background.js)       │
│  • Manages offscreen document lifecycle                      │
│  • Routes embedding requests                                 │
└─────────────────────────────────────────────────────────────┘
                            ↕ Message Passing
┌─────────────────────────────────────────────────────────────┐
│              Offscreen Document (offscreen.js)               │
│  • Loads MiniLM-L6-v2 ONNX model                            │
│  • Performs text embedding (mean pooling, L2 norm)          │
│  • Returns 384-dim vectors                                   │
│  • Has full API access (Atomics.wait for WASM)              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     Popup UI (popup.html/js)                 │
│  • Threshold slider control                                  │
│  • Blocked items list management                             │
│  • Mode selection (local/remote)                             │
│  • Cache management                                          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                 Chrome Local Storage                         │
│  • Blocked items (positive examples)                         │
│  • Negative examples                                         │
│  • Embedding cache                                           │
│  • User settings (threshold, mode, backend URL)              │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **User Blocks Video** → Content Script
2. **Extract Metadata** → Content Script
3. **Request Embedding** → Background → Offscreen → Model
4. **Store Embedding** → Chrome Local Storage
5. **New Video Appears** → Content Script detects
6. **Compute Similarity** → Compare with blocked embeddings
7. **Apply Filter** → Hide if similarity > threshold
8. **User Feedback** → Update negative examples or threshold

---

## Technical Details

### AI Model

**Model**: `sentence-transformers/all-MiniLM-L6-v2`
- **Architecture**: 6-layer MiniLM (distilled BERT)
- **Output**: 384-dimensional embeddings
- **Training**: Contrastive learning on 1B+ sentence pairs
- **Quantization**: INT8 for faster browser inference
- **Size**: ~23MB (quantized ONNX)

**Why MiniLM-L6-v2?**
- Fast enough for real-time operation (~80-150ms per embedding)
- High-quality semantic understanding for short texts
- Well-validated in academic literature
- Optimal size/speed/accuracy tradeoff for browser use

### Embedding Process

```javascript
// Text normalization
text = `${videoTitle} — ${channelName}`

// Tokenization → Model → Mean Pooling → L2 Normalization
embedding = model(text)  // 384-dim Float32Array

// Similarity calculation
similarity = cosineSimilarity(embedding1, embedding2)
// Returns value in [0, 1] where 1 = identical meaning
```

### Filtering Logic

```javascript
function shouldBlock(video) {
  // 1. Check negative examples (user said "not similar")
  for (neg of negativeExamples) {
    if (similarity(video, neg) >= threshold)
      return false;  // Don't block - similar to negative
  }
  
  // 2. Check positive examples (user blocked)
  for (blocked of blockedItems) {
    if (similarity(video, blocked) >= threshold)
      return true;  // Block - similar to blocked item
  }
  
  return false;  // Don't block by default
}
```

### Performance Optimizations

- **Embedding Cache**: Avoids recomputing identical text
- **Batch Processing**: Groups embedding requests (batch size: 8)
- **Debounced DOM Observer**: Reduces CPU usage (220ms delay)
- **Intersection Observer**: Only processes viewport-visible content
- **Idle Callbacks**: Non-blocking execution via `requestIdleCallback`
- **Float32Array**: Efficient vector operations

---

## Configuration

### Storage Keys

All data stored in Chrome Local Storage:

| Key | Description | Default |
|-----|-------------|---------|
| `ytd_ai_blocked_items_v2` | Positive examples (blocked content) | `[]` |
| `ytd_ai_negative_v2` | Negative examples ("not similar") | `[]` |
| `ytd_ai_cache_v2` | Embedding cache (text → vector) | `{}` |
| `ytd_ai_threshold_v2` | Similarity threshold | `0.7` |
| `ytd_ai_mode_v2` | Inference mode | `"local"` |
| `ytd_ai_backend_v2` | Remote backend URL | `""` |

### Threshold Guidelines

- **0.50-0.60**: Very aggressive - blocks broadly similar content
- **0.60-0.70**: Aggressive - catches related topics
- **0.70-0.80**: Balanced - similar themes and channels (default: 0.70)
- **0.80-0.90**: Conservative - very similar content only
- **0.90-1.00**: Strict - nearly identical content

### Remote Backend API

If using remote mode, your backend must implement:

**POST** `/embed`
```json
// Request
{
  "texts": ["Video Title — Channel Name", "Another Title — Channel"]
}

// Response
{
  "embeddings": [
    [0.123, -0.456, ...],  // 384 numbers
    [0.789, -0.012, ...]
  ]
}
```

---

## Development

### Project Structure

```
youtube-ai-blocker/
├── src/
│   ├── content_script.js    # Main filtering logic
│   ├── background.js        # Service worker
│   ├── offscreen.js         # ONNX model inference
│   ├── offscreen.html       # Offscreen document
│   ├── popup.html           # Extension UI
│   ├── popup.js             # Popup logic
│   ├── styles.css           # UI styles
│   └── models/
│       └── all-minilm-l6-v2/
│           ├── config.json
│           ├── model.onnx
│           └── tokenizer.json
├── manifest.json            # Extension manifest
├── package.json             # Dependencies
├── download-model.js        # Model download script
├── requirements.txt         # Python deps (optional backend)
├── PROJECT_CHECKLIST.md     # Development status
└── README.md               # This file
```

### Building

```bash
# Install dependencies
npm install

# Download model files
node download-model.js

# Build extension (copies to dist/)
npm run build

# Development mode (watch for changes)
npm run dev

# Lint code
npm run lint
```

### Testing Locally

1. Make changes to source files in `src/`
2. Rebuild with `npm run build`
3. Go to `chrome://extensions/`
4. Click reload icon on the extension card
5. Reload YouTube page to test changes

### Adding Features

**New filtering criteria:**
- Edit `extractVideoInfoFromTile()` in `content_script.js`
- Add description, tags, or other metadata
- Embeddings automatically include new text

**New UI elements:**
- Edit `popup.html` for structure
- Edit `popup.js` for logic
- Edit `styles.css` for appearance

**Model changes:**
- Update model name in `offscreen.js`
- Run `node download-model.js` with new model
- Adjust embedding dimensions if needed

---

## Academic Context

### Research Background

This project is part of academic research into **user-in-the-loop machine learning** and **personalized content filtering**. It addresses key challenges in:

- **Information Overload**: Too much content, not enough control
- **Algorithmic Transparency**: Users don't understand recommendation systems
- **Digital Autonomy**: Centralized platforms control content exposure
- **Privacy-Preserving AI**: On-device inference without data transmission

### Related Work

- **Content Filtering**: BlockTube, Channel Blocker (keyword-based)
- **Text Embeddings**: BERT (Devlin et al., 2019), DistilBERT (Sanh et al., 2019)
- **Sentence Transformers**: MiniLM (Wang et al., 2020)
- **Continual Learning**: Online learning, adaptive thresholds
- **Ethical AI**: User agency, transparency, privacy preservation

### Novel Contributions

1. **Semantic Understanding**: Beyond keywords to meaning-based filtering
2. **Local AI Inference**: Privacy-preserving on-device execution
3. **Adaptive Learning**: System improves from positive and negative feedback
4. **Real-Time Operation**: Efficient enough for live browsing
5. **User Control**: Transparent, reversible, adjustable decisions

### Research Questions

- **RQ1**: Can embedding-based similarity effectively filter content based on user preferences?
- **RQ2**: How does user feedback (negative examples) improve filtering accuracy?
- **RQ3**: What is the optimal similarity threshold for personalized filtering?
- **RQ4**: How does the system's performance evolve over time with more data?

### Evaluation Methodology

*Note: Quantitative evaluation system is planned but not yet implemented.*

**Planned Metrics:**
- Precision: TP / (TP + FP) - Accuracy of automatic blocking
- Recall: TP / (TP + FN) - Completeness of filtering
- F1 Score: Harmonic mean of precision and recall
- User Satisfaction: Qualitative surveys and interviews
- Longitudinal Analysis: Performance over weeks of use

**Planned User Study:**
- 10-20 participants
- 2-4 weeks of natural YouTube usage
- Pre/post surveys
- Interview sessions
- Usage logs and metrics

---

## FAQ

### General Questions

**Q: Does this extension collect my data?**  
A: No. All processing happens locally in your browser. Nothing is sent to external servers unless you explicitly configure a remote backend.

**Q: Will this slow down YouTube?**  
A: No. The extension uses performance optimizations (lazy loading, caching, idle callbacks) to avoid impacting browsing speed.

**Q: Can I use this on other websites?**  
A: Currently only YouTube is supported. The architecture could be adapted for other video platforms with similar DOM structures.

**Q: How much storage does this use?**  
A: Minimal. Each blocked item stores ~1.5KB (text + 384 floats). 100 blocked items = ~150KB. Cache grows with unique content seen but is clearable.

### Technical Questions

**Q: Why use an offscreen document?**  
A: ONNX Runtime's WebAssembly backend requires `Atomics.wait()`, which is blocked in content scripts and service workers. Offscreen documents have full API access.

**Q: Can I use a different model?**  
A: Yes! Edit `offscreen.js` to load a different SentenceTransformers model. Ensure it's available in ONNX format via Xenova/transformers.

**Q: What's the difference between local and remote mode?**  
A: Local mode runs the ONNX model in your browser (private, slower initial load). Remote mode calls your own API server (faster, requires setup).

**Q: Why embeddings instead of training a classifier?**  
A: Embeddings are more data-efficient. You can filter content after blocking just 1-2 examples. Training a full classifier typically requires hundreds of examples.

### Troubleshooting

**Q: The extension isn't working**  
1. Check that you're on `youtube.com` (not mobile YouTube or embedded videos)
2. Open DevTools console (F12) and look for errors
3. Try disabling/re-enabling the extension
4. Rebuild from source if you made changes

**Q: Blocked videos aren't showing placeholders**  
- This is a timing issue. The video was filtered but the placeholder didn't render.
- Refresh the page - it should work on subsequent loads.

**Q: Model loading failed**  
- Ensure `src/models/all-minilm-l6-v2/` contains all three files (config.json, model.onnx, tokenizer.json)
- Run `node download-model.js` to re-download
- Check console for specific error messages

**Q: Threshold slider doesn't work**  
- Ensure the popup can communicate with content script
- Check that YouTube tab has the content script loaded (reload page)
- Look for errors in both popup and page console

---

## Contributing

This is an academic research project. Contributions are welcome after the initial evaluation phase.

### Planned Improvements

- [ ] Metrics tracking system for academic validation
- [ ] User study protocol and data collection tools
- [ ] Automatic threshold adaptation based on user corrections
- [ ] Lightweight classifier training (logistic regression on embeddings)
- [ ] Video description inclusion in embeddings
- [ ] Export/import functionality for backups
- [ ] Multi-platform support (Firefox, Safari)
- [ ] A/B testing framework
- [ ] Performance benchmarking suite

### How to Contribute (After Research Phase)

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Test thoroughly on YouTube
5. Commit with descriptive messages
6. Push to your fork
7. Open a Pull Request

### Code Style

- Use clear, descriptive variable names
- Add comments for complex logic
- Follow existing code structure
- Test on multiple YouTube pages (home, search, channel, watch)
- Ensure no console errors

---

## License

This project is licensed under the MIT License - see the LICENSE file for details.

**Academic Use**: If you use this project in academic research, please cite:

```
@misc{youtube-ai-blocker-2026,
  title={AI-Powered Browser Extension for Intelligent Web Content Filtering},
  author={[Your Name]},
  year={2026},
  howpublished={\url{https://github.com/yourusername/youtube-ai-blocker}}
}
```

---

## Acknowledgments

- **Xenova/transformers**: Outstanding browser-based ML inference library
- **Sentence-Transformers**: High-quality embedding models
- **Hugging Face**: Model hosting and distribution
- **OpenAI**: Transformer architecture inspiration
- **Chrome Extensions Team**: Excellent developer documentation

---

## Contact

For questions, feedback, or collaboration inquiries:

- **GitHub Issues**: [https://github.com/yourusername/youtube-ai-blocker/issues](https://github.com/yourusername/youtube-ai-blocker/issues)
- **Email**: your.email@university.edu
- **Research Group**: [Your Lab Website]

---

## Links

- [Project Repository](https://github.com/yourusername/youtube-ai-blocker)
- [Detailed Checklist](PROJECT_CHECKLIST.md)
- [Chrome Extension Documentation](https://developer.chrome.com/docs/extensions/)
- [Sentence-Transformers](https://www.sbert.net/)
- [Xenova/transformers](https://huggingface.co/docs/transformers.js)

---

**Built for better digital experiences and user autonomy**

*Last Updated: February 10, 2026*
