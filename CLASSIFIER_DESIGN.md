# Classifier Training Design Document

## Overview

Add a lightweight **logistic regression classifier** to improve filtering accuracy beyond simple similarity matching.

---

## Architecture

### Current System (Similarity-Based)
```
Video → Embedding → Compare to each blocked item → Threshold → Block/Allow
```

**Pros:**
- Works with just 1 blocked example
- Fast and transparent
- No training needed

**Cons:**
- Must be similar to at least ONE blocked item
- Can't learn patterns across multiple examples
- Treats all blocked items independently

### Proposed System (Hybrid)
```
Video → Embedding → [Similarity Check] → Block if match
                  ↘ [Classifier]      ↘ Block if predicted
```

**Classifier adds:**
- Learns from ALL examples simultaneously
- Can identify patterns (e.g., "all gaming content")
- Improves as more examples accumulate
- Handles class imbalance (many negatives, few positives)

---

## Logistic Regression Basics

### Model
```
P(block | embedding) = sigmoid(w · x + b)

where:
  x = 384-dim embedding
  w = learned weights (384 values)
  b = learned bias (1 value)
  sigmoid(z) = 1 / (1 + e^(-z))
```

### Training (Gradient Descent)
```javascript
// For each training example (x, y):
prediction = sigmoid(dot(w, x) + b)
error = prediction - y
w = w - learning_rate * error * x
b = b - learning_rate * error
```

### Advantages
- Simple: Just 385 parameters (384 weights + 1 bias)
- Fast: Training takes ~10-50ms for 100 examples
- Incremental: Can update with new examples
- Interpretable: Weights show which embedding dimensions matter

---

## Implementation Plan

### 1. Storage Structure

Add new storage keys:

```javascript
const CLASSIFIER_KEY = "ytd_ai_classifier_v2";  // Stores trained model
const CLASSIFIER_ENABLED_KEY = "ytd_ai_classifier_enabled_v2";  // On/off toggle

// Classifier object structure:
{
  weights: Float32Array(384),  // Learned coefficients
  bias: 0.0,                   // Learned intercept
  trainedOn: 0,                // Number of examples used
  lastTrained: timestamp,      // When last trained
  version: 1                   // Model version
}
```

### 2. Classifier Module

Create `classifier.js` with:

```javascript
class LogisticRegressionClassifier {
  constructor() {
    this.weights = null;  // Float32Array(384)
    this.bias = 0.0;
    this.learningRate = 0.01;
    this.regularization = 0.001;  // L2 penalty
    this.trainedOn = 0;
  }
  
  // Train from scratch on all examples
  train(embeddings, labels, epochs=100) { ... }
  
  // Update incrementally with one new example
  update(embedding, label, iterations=10) { ... }
  
  // Predict probability [0, 1]
  predict(embedding) { ... }
  
  // Serialize/deserialize for storage
  toJSON() { ... }
  fromJSON(data) { ... }
}
```

### 3. Training Trigger

```javascript
async function maybeTrainClassifier() {
  if (!classifierEnabled) return;
  
  const minPositives = 10;  // Need at least 10 blocked examples
  const minNegatives = 5;   // Need at least 5 "not similar" examples
  
  if (blockedItems.length < minPositives || 
      negativeItems.length < minNegatives) {
    console.log("Not enough data to train classifier");
    return;
  }
  
  // Prepare training data
  const X = [];  // embeddings
  const y = [];  // labels (1=block, 0=allow)
  
  for (const item of blockedItems) {
    X.push(Float32Array.from(item.embedding));
    y.push(1);
  }
  
  for (const item of negativeItems) {
    X.push(Float32Array.from(item.embedding));
    y.push(0);
  }
  
  // Balance classes if needed (optional)
  // balanceData(X, y);
  
  // Train classifier
  classifier.train(X, y, epochs=100);
  
  // Save to storage
  saveClassifier();
  
  console.log(`Classifier trained on ${X.length} examples`);
}
```

### 4. Integration into Filtering

Modify `shouldBlockText()`:

```javascript
async function shouldBlockText(title, channel) {
  const text = `${title} — ${channel}`;
  const emb = await embed(text);
  
  let blockReasons = [];
  
  // Method 1: Check negative examples (veto)
  for (const neg of negativeItems) {
    const simNeg = cosineSimilarity(emb, Float32Array.from(neg.embedding));
    if (simNeg >= threshold) {
      return { 
        block: false, 
        reason: "matched_negative", 
        simNeg 
      };
    }
  }
  
  // Method 2: Similarity matching
  let maxSim = 0;
  let matchedItem = null;
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
  
  // Method 3: Classifier prediction
  if (classifierEnabled && classifier && classifier.weights) {
    const prob = classifier.predict(emb);
    const classifierThreshold = 0.5;  // Could be adjustable
    
    if (prob >= classifierThreshold) {
      blockReasons.push({
        method: "classifier",
        confidence: prob
      });
    }
  }
  
  // Decision logic: Block if ANY method says block
  if (blockReasons.length > 0) {
    return {
      block: true,
      reasons: blockReasons,
      matched: matchedItem,
      sim: maxSim
    };
  }
  
  return { block: false };
}
```

### 5. UI Updates

Add to `popup.html`:

```html
<div style="margin-top:12px;">
  <label style="display:flex;align-items:center;gap:8px;">
    <input type="checkbox" id="classifierEnabled" />
    <span>Enable Classifier (requires 10+ blocked, 5+ negatives)</span>
  </label>
</div>

<div id="classifierStatus" style="margin-top:8px;font-size:12px;color:#666;">
  Classifier: Not enough data
</div>

<button id="retrainClassifier" style="margin-top:8px;">
  Retrain Classifier Now
</button>
```

Add to `popup.js`:

```javascript
// Load classifier status
chrome.storage.local.get([CLASSIFIER_ENABLED_KEY, CLASSIFIER_KEY, ...], (data) => {
  const enabled = data[CLASSIFIER_ENABLED_KEY] || false;
  const classifier = data[CLASSIFIER_KEY];
  
  document.getElementById("classifierEnabled").checked = enabled;
  updateClassifierStatus(data[STORAGE_KEY], data[NEGATIVE_KEY], classifier);
});

// Update status display
function updateClassifierStatus(blocked, negative, classifier) {
  const statusEl = document.getElementById("classifierStatus");
  
  const numPos = (blocked || []).length;
  const numNeg = (negative || []).length;
  
  if (classifier && classifier.trainedOn > 0) {
    statusEl.innerText = `Classifier: Trained on ${classifier.trainedOn} examples`;
    statusEl.style.color = "green";
  } else if (numPos >= 10 && numNeg >= 5) {
    statusEl.innerText = `Classifier: Ready to train (${numPos} blocked, ${numNeg} negative)`;
    statusEl.style.color = "orange";
  } else {
    statusEl.innerText = `Classifier: Need ${Math.max(0, 10-numPos)} more blocked, ${Math.max(0, 5-numNeg)} more negative`;
    statusEl.style.color = "#999";
  }
}

// Retrain button
document.getElementById("retrainClassifier").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "retrainClassifier" }, (response) => {
    if (response.success) {
      alert(`Classifier trained successfully on ${response.numExamples} examples`);
    } else {
      alert(`Training failed: ${response.error}`);
    }
  });
});
```

---

## Training Strategy

### Initial Training
- Wait until 10+ blocked items AND 5+ negative items
- Train from scratch with gradient descent
- 100 epochs (usually converges in 20-50)
- Save weights to storage

### Incremental Updates
- When user blocks new content → add to training set
- When user marks "not similar" → add negative example
- Retrain periodically (e.g., every 5 new examples)
- Or retrain on-demand via button

### Data Balancing (Optional)
If you have 50 blocked items but only 5 negatives:
- Oversample negatives (duplicate with small noise)
- Undersample positives (random subset)
- Or use class weights in loss function

---

## Performance Considerations

### Training Speed
- 384 dimensions × 100 examples × 100 epochs = ~3.8M operations
- JavaScript can handle this in 10-50ms
- Train asynchronously to avoid blocking UI

### Memory
- Weights: 384 floats × 4 bytes = 1.5KB
- Minimal storage overhead

### Accuracy
- Logistic regression is a strong baseline
- With good embeddings, can achieve 85-95% accuracy
- Will improve as more examples accumulate

---

## Testing Plan

### Unit Tests
1. Train on synthetic data, verify convergence
2. Test serialization/deserialization
3. Test incremental updates

### Integration Tests
1. Block 10 gaming videos, 5 cooking videos as negative
2. Verify classifier learns pattern
3. Test on new gaming/cooking videos
4. Measure precision/recall

### A/B Comparison
- Compare similarity-only vs hybrid mode
- Track: false positives, false negatives, user corrections
- Measure over 1-2 weeks of use

---

## Advanced Features (Future)

### Confidence Calibration
- Adjust classifier threshold based on user tolerance
- Lower threshold = more aggressive blocking

### Feature Importance
- Examine learned weights
- Identify which embedding dimensions are most predictive
- Could enable explainability ("blocked because of topic/style patterns")

### Multi-Class Classification
- Instead of binary (block/allow), learn categories
- "Gaming", "Politics", "Music", etc.
- Block entire categories

### Online Learning
- Update weights after every prediction
- Faster adaptation to changing preferences

### Ensemble Methods
- Combine multiple classifiers
- Voting or weighted average

---

## Implementation Phases

### Phase 1: Core Classifier (1-2 days)
- [ ] Create `classifier.js` with LogisticRegressionClassifier
- [ ] Add storage keys and serialization
- [ ] Implement training algorithm
- [ ] Add unit tests

### Phase 2: Integration (1 day)
- [ ] Integrate into `shouldBlockText()`
- [ ] Add training trigger logic
- [ ] Test with real data

### Phase 3: UI (1 day)
- [ ] Add enable/disable toggle
- [ ] Add status display
- [ ] Add retrain button
- [ ] Update popup styling

### Phase 4: Optimization (1 day)
- [ ] Profile training performance
- [ ] Add data balancing
- [ ] Tune hyperparameters
- [ ] Add logging for evaluation

---

## Success Metrics

### Before Classifier (Similarity Only)
- Works with 1 example
- Precision: ~80-85%
- Recall: ~60-70%
- F1: ~70-75%

### After Classifier (Hybrid)
- Needs 10+ examples to activate
- Expected Precision: ~85-90%
- Expected Recall: ~75-85%
- Expected F1: ~80-87%

### Key Improvements
- Better generalization across similar content
- Fewer false positives (learns what NOT to block)
- Stronger signal when both methods agree

---

## Code Style Guidelines

- Keep classifier code in separate module for testability
- Use Float32Array for performance
- Add extensive comments explaining math
- Log training progress for debugging
- Graceful degradation if classifier fails

---

## Questions to Consider

1. **Should classifier completely replace similarity, or augment it?**
   - Recommendation: Augment (hybrid mode)

2. **What minimum data requirements?**
   - Recommendation: 10 positives, 5 negatives

3. **Retrain on every new example, or batch?**
   - Recommendation: Batch every 5 new examples, or on-demand

4. **How to handle class imbalance?**
   - Recommendation: Start without balancing, add if needed

5. **Should classifier threshold be user-adjustable?**
   - Recommendation: Start fixed at 0.5, could add slider later

---

## Next Steps

1. Create `classifier.js` with full implementation
2. Update `content_script.js` to integrate
3. Update `popup.html` and `popup.js` for UI
4. Add comprehensive comments
5. Test with your existing data