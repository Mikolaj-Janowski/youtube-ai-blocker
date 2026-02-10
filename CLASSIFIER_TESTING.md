# Classifier Testing Guide

## Quick Start Testing

### Prerequisites
1. Extension built and loaded in Chrome
2. YouTube page open
3. Console open (F12) to see debug logs

### Test Scenario 1: Insufficient Data
**Goal:** Verify classifier requires minimum data before training

1. **Open extension popup**
2. **Check classifier status** - Should show "Not enough data"
3. **Enable classifier checkbox** - Check the box
4. **Note the requirements** - Should say "Need X more blocked, Y more not similar"

**Expected:** Classifier remains disabled until you have 10+ blocked and 5+ negatives

---

### Test Scenario 2: Collect Training Data
**Goal:** Build up training data for classifier

#### Block 10+ Similar Videos
1. **Go to YouTube homepage or search**
2. **Pick a topic** (e.g., "gaming", "cooking", "politics")
3. **Block 10-15 videos** from that topic
   - Click "Block" button on each video
   - Videos should be hidden with placeholder
   - Console should log: "Blocked item added"

#### Mark 5+ Different Videos as "Not Similar"
1. **Search for a completely different topic** (e.g., if you blocked gaming, search for music)
2. **Let a video get auto-blocked** (it might be if it's borderline)
3. **Click "Not similar"** on the placeholder
   - This teaches: "Don't block this type of content"
4. **Repeat for 5 different types of content**

**Alternative if nothing auto-blocks:**
- Manually block a video from a different topic
- Immediately go to popup → Blocked Items → Remove it
- Then block another similar video and mark "Not similar"
- This adds it as a negative example

---

### Test Scenario 3: Train the Classifier
**Goal:** Verify classifier trains successfully

1. **Open extension popup**
2. **Check status** - Should now say "✓ Ready to train"
3. **Click "Retrain Classifier Now"** button
4. **Watch console** in YouTube tab:
   ```
   Training classifier on 10 positives and 5 negatives...
   Epoch 0: Loss = X.XXXX
   Epoch 20: Loss = X.XXXX
   ...
   Training complete. Accuracy: XX.X%
   ```
5. **Check popup status** - Should show "✓ Trained on X examples"

**Expected:**
- Training completes in ~1-2 seconds
- Accuracy should be 70-100% (on training data)
- Popup shows green checkmark and timestamp

---

### Test Scenario 4: Hybrid Filtering in Action
**Goal:** Verify both similarity AND classifier work together

1. **Ensure classifier is enabled and trained**
2. **Browse YouTube** (homepage, search results)
3. **Watch console logs** for predictions:
   ```
   Classifier prediction for "Video Title": 85.2%
   ```
4. **Look for blocked content** with placeholder showing:
   ```
   Blocked by AI
   Matched: Original Video — Channel (sim 0.75)
   Methods: similarity (75%) + classifier (85%)
   ```

**Key Test Cases:**

#### Case A: Both Methods Agree (High Confidence)
- **Setup:** Browse similar content to what you blocked
- **Expected:** 
  - Both similarity AND classifier trigger
  - Placeholder shows "Methods: similarity (X%) + classifier (Y%)"
  - Video is blocked

#### Case B: Only Classifier Triggers
- **Setup:** Browse content semantically similar but different wording
- **Expected:**
  - Similarity might be below threshold (< 70%)
  - Classifier catches it (> 50%)
  - Placeholder shows "Methods: classifier (X%)"
  - Video is blocked

#### Case C: Only Similarity Triggers
- **Setup:** Browse exact duplicate or very similar title/channel
- **Expected:**
  - Similarity is very high (> 70%)
  - Classifier might be lower but doesn't matter
  - Video is blocked

#### Case D: Neither Triggers
- **Setup:** Browse completely unrelated content
- **Expected:**
  - Console shows low classifier prediction (< 50%)
  - Similarity is low (< 70%)
  - Video is NOT blocked

---

### Test Scenario 5: Negative Examples Veto
**Goal:** Verify negative examples prevent false positives

1. **Find a video** that got incorrectly blocked
2. **Click "Not similar"** on the placeholder
3. **Trigger retraining** (popup → Retrain Classifier Now)
4. **Reload YouTube page**
5. **Search for similar content** to the one you marked "not similar"

**Expected:**
- Similar videos are no longer blocked
- Console might show: "matched_negative" reason
- Classifier learns to avoid this type of content

---

### Test Scenario 6: Real-Time Threshold Adjustment
**Goal:** Verify threshold changes affect classifier

1. **Open popup**
2. **Move similarity threshold slider** to 0.5 (aggressive)
3. **Watch YouTube page** - more content should be blocked
4. **Move slider to 0.9** (conservative)
5. **Watch page** - less content blocked (you might need to refresh)

**Note:** Classifier threshold is fixed at 0.5 (50% probability)

---

### Test Scenario 7: Incremental Learning
**Goal:** Verify classifier improves over time

1. **Initial training** with 10 blocked + 5 negatives
2. **Note initial accuracy** in console
3. **Block 5 more videos** from the same topic
4. **Mark 2 more as "not similar"** from different topics
5. **Retrain classifier**
6. **Compare accuracy** - should be same or higher

**Expected:**
- More data → better accuracy
- Classifier becomes more confident (higher/lower probabilities)
- Fewer false positives over time

---

## Advanced Testing

### Test Incremental Update (Optional)
The classifier has an `update()` method for online learning, but it's not currently used in the UI. To test it manually:

1. **Open console on YouTube**
2. **Run:**
```javascript
// This won't work directly because classifier is not exposed
// You'd need to modify content_script.js to expose it
```

### Test Balancing (If Implemented)
If you have 50 blocked items but only 5 negatives:
- Classifier might be biased toward blocking
- Consider adding class balancing in `maybeTrainClassifier()`

---

## Debugging

### Console Commands

Check classifier status:
```javascript
// In content script context (YouTube page):
console.log(classifier.getStats());
```

View all blocked items:
```javascript
chrome.storage.local.get(['ytd_ai_blocked_items_v2'], (data) => {
  console.log(data.ytd_ai_blocked_items_v2);
});
```

View classifier model:
```javascript
chrome.storage.local.get(['ytd_ai_classifier_v2'], (data) => {
  console.log(data.ytd_ai_classifier_v2);
});
```

### Common Issues

**Issue:** Classifier won't train
- **Check:** Do you have 10+ blocked AND 5+ negatives?
- **Check:** Is classifier enabled in popup?
- **Check:** Are you on a YouTube page?

**Issue:** No console logs showing
- **Check:** F12 console open on YouTube tab (not popup)
- **Check:** Content script loaded? (refresh page)

**Issue:** Training fails with error
- **Check:** Console for error message
- **Check:** Embeddings are valid Float32Arrays
- **Check:** No NaN or Infinity values

**Issue:** Accuracy is very low (< 60%)
- **Possible:** Data is too diverse or contradictory
- **Solution:** Clear data and start with more focused blocking

**Issue:** Classifier blocks everything
- **Possible:** All negatives are similar to positives
- **Solution:** Add more diverse negative examples

**Issue:** Classifier blocks nothing
- **Possible:** Threshold too high or not enough training
- **Solution:** Retrain or add more data

---

## Expected Results Summary

### Minimum Requirements
- ✅ 10+ blocked items
- ✅ 5+ negative examples
- ✅ Classifier enabled in popup
- ✅ Training completes without errors

### Training Performance
- Training time: 1-3 seconds
- Training accuracy: 70-100%
- Model size: ~1.5KB (384 weights + 1 bias)

### Filtering Performance
- Prediction time: ~1-2ms per video
- Expected accuracy: 75-90% (on new content)
- Improvement: 5-15% better than similarity alone

### User Experience
- ✅ Transparent: Shows which method blocked content
- ✅ Reversible: Can unblock and mark "not similar"
- ✅ Adaptive: Retrains as you add more examples
- ✅ Fast: No noticeable lag when browsing

---

## Performance Metrics to Track

If implementing full evaluation system, track:

1. **True Positives (TP):** Correctly blocked
2. **False Positives (FP):** Incorrectly blocked (user clicks "Show this")
3. **True Negatives (TN):** Correctly allowed
4. **False Negatives (FN):** Should have blocked but didn't (user manually blocks)

**Formulas:**
- Precision = TP / (TP + FP)
- Recall = TP / (TP + FN)
- F1 Score = 2 × (Precision × Recall) / (Precision + Recall)

---

## Next Steps After Testing

1. ✅ Verify classifier works correctly
2. ✅ Collect real usage data
3. Implement metrics tracking system
4. Run user studies
5. Analyze comparative performance (similarity vs hybrid)
6. Document results for research paper

---

## Quick Troubleshooting Checklist

- [ ] Extension rebuilt after changes? (`npm run build`)
- [ ] Extension reloaded in chrome://extensions?
- [ ] YouTube page refreshed?
- [ ] Console open on correct tab?
- [ ] Classifier enabled in popup?
- [ ] Minimum data requirements met?
- [ ] Training completed successfully?
- [ ] No JavaScript errors in console?

---

**Happy Testing!**

Remember: The classifier is a complement to similarity matching, not a replacement. Both methods working together provide the best results.

