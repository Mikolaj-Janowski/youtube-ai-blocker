// classifier.js
// Lightweight logistic regression classifier for binary classification
// Operates on embedding vectors (Float32Array) to predict block/allow

/**
 * Logistic Regression Classifier for Content Filtering
 * 
 * Uses gradient descent to learn weights that predict P(block | embedding)
 * Trained on user feedback: blocked items (label=1) and negatives (label=0)
 */
export class LogisticRegressionClassifier {
  constructor() {
    this.weights = null;        // Float32Array(embeddingDim)
    this.bias = 0;              // Scalar
    this.learningRate = 0.01;   // Step size for gradient descent
    this.regularization = 0.001; // L2 penalty to prevent overfitting
    this.trainedOn = 0;         // Number of examples in last training
    this.embeddingDim = 384;    // MiniLM-L6-v2 dimension
    this.lastTrained = null;    // Timestamp
    this.version = 1;           // Model version
  }

  /**
   * Sigmoid activation function
   * Maps any real number to [0, 1]
   */
  sigmoid(z) {
    return 1 / (1 + Math.exp(-z));
  }

  /**
   * Compute dot product of weights and embedding
   */
  dotProduct(weights, embedding) {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) {
      sum += weights[i] * embedding[i];
    }
    return sum;
  }

  /**
   * Predict probability of blocking given an embedding
   * @param {Float32Array} embedding - 384-dim vector
   * @returns {number} Probability in [0, 1]
   */
  predict(embedding) {
    if (!this.weights) {
      throw new Error("Classifier not trained yet");
    }

    // Linear combination: w·x + b
    const z = this.dotProduct(this.weights, embedding) + this.bias;
    
    // Apply sigmoid to get probability
    return this.sigmoid(z);
  }

  /**
   * Train classifier from scratch on all examples
   * @param {Array<Float32Array>} X - Array of embeddings
   * @param {Array<number>} y - Array of labels (1=block, 0=allow)
   * @param {number} epochs - Number of training iterations
   * @param {boolean} verbose - Log training progress
   * @returns {Object} Training statistics
   */
  train(X, y, epochs = 100, verbose = false) {
    if (X.length === 0 || y.length === 0) {
      throw new Error("Cannot train on empty data");
    }
    if (X.length !== y.length) {
      throw new Error("X and y must have same length");
    }

    const n = X.length;
    this.embeddingDim = X[0].length;

    // Initialize weights randomly (small values)
    this.weights = new Float32Array(this.embeddingDim);
    for (let i = 0; i < this.embeddingDim; i++) {
      this.weights[i] = (Math.random() - 0.5) * 0.01; // [-0.005, 0.005]
    }
    this.bias = 0;

    // Training loop
    const losses = [];
    for (let epoch = 0; epoch < epochs; epoch++) {
      let totalLoss = 0;

      // Shuffle data each epoch for better convergence
      const indices = Array.from({length: n}, (_, i) => i);
      this.shuffle(indices);

      // Process each example
      for (const idx of indices) {
        const xi = X[idx];
        const yi = y[idx];

        // Forward pass: compute prediction
        const prediction = this.predict(xi);

        // Compute error
        const error = prediction - yi;

        // Backward pass: update weights using gradient descent
        // Gradient of loss w.r.t. weights: error * xi + regularization * weights
        for (let j = 0; j < this.embeddingDim; j++) {
          const gradient = error * xi[j] + this.regularization * this.weights[j];
          this.weights[j] -= this.learningRate * gradient;
        }

        // Update bias (no regularization on bias)
        this.bias -= this.learningRate * error;

        // Accumulate loss for monitoring
        // Binary cross-entropy: -[y*log(p) + (1-y)*log(1-p)]
        const loss = yi === 1 
          ? -Math.log(Math.max(prediction, 1e-10))
          : -Math.log(Math.max(1 - prediction, 1e-10));
        totalLoss += loss;
      }

      const avgLoss = totalLoss / n;
      losses.push(avgLoss);

      // Log progress every 20 epochs
      if (verbose && epoch % 20 === 0) {
        console.log(`Epoch ${epoch}: Loss = ${avgLoss.toFixed(4)}`);
      }
    }

    this.trainedOn = n;
    this.lastTrained = Date.now();

    // Calculate final training accuracy
    let correct = 0;
    for (let i = 0; i < n; i++) {
      const pred = this.predict(X[i]) >= 0.5 ? 1 : 0;
      if (pred === y[i]) correct++;
    }
    const accuracy = correct / n;

    if (verbose) {
      console.log(`Training complete. Accuracy: ${(accuracy * 100).toFixed(1)}%`);
    }

    return {
      finalLoss: losses[losses.length - 1],
      accuracy: accuracy,
      epochs: epochs,
      numExamples: n
    };
  }

  /**
   * Update classifier incrementally with a single new example
   * Useful for online learning without full retraining
   * @param {Float32Array} embedding - New example embedding
   * @param {number} label - Label (1=block, 0=allow)
   * @param {number} iterations - Number of gradient steps
   */
  update(embedding, label, iterations = 10) {
    if (!this.weights) {
      // If not trained yet, initialize with this single example
      this.weights = new Float32Array(embedding.length);
      this.embeddingDim = embedding.length;
    }

    // Perform multiple gradient steps on this single example
    for (let i = 0; i < iterations; i++) {
      const prediction = this.predict(embedding);
      const error = prediction - label;

      // Update weights
      for (let j = 0; j < this.embeddingDim; j++) {
        const gradient = error * embedding[j] + this.regularization * this.weights[j];
        this.weights[j] -= this.learningRate * gradient;
      }

      // Update bias
      this.bias -= this.learningRate * error;
    }

    this.trainedOn += 1;
    this.lastTrained = Date.now();
  }

  /**
   * Fisher-Yates shuffle algorithm (in-place)
   */
  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  /**
   * Serialize classifier to plain object for storage
   */
  toJSON() {
    return {
      weights: this.weights ? Array.from(this.weights) : null,
      bias: this.bias,
      trainedOn: this.trainedOn,
      embeddingDim: this.embeddingDim,
      lastTrained: this.lastTrained,
      version: this.version
    };
  }

  /**
   * Deserialize classifier from stored object
   */
  fromJSON(data) {
    if (!data) return;
    
    this.weights = data.weights ? Float32Array.from(data.weights) : null;
    this.bias = data.bias || 0;
    this.trainedOn = data.trainedOn || 0;
    this.embeddingDim = data.embeddingDim || 384;
    this.lastTrained = data.lastTrained || null;
    this.version = data.version || 1;
  }

  /**
   * Check if classifier is ready to make predictions
   */
  isReady() {
    return this.weights !== null && this.trainedOn > 0;
  }

  /**
   * Get classifier statistics
   */
  getStats() {
    return {
      ready: this.isReady(),
      trainedOn: this.trainedOn,
      lastTrained: this.lastTrained,
      version: this.version,
      parameterCount: this.weights ? this.weights.length + 1 : 0
    };
  }
}

/**
 * Helper function to balance dataset if classes are imbalanced
 * @param {Array<Float32Array>} X - Embeddings
 * @param {Array<number>} y - Labels
 * @returns {Object} Balanced X and y
 */
export function balanceDataset(X, y) {
  const positives = [];
  const negatives = [];

  // Separate by class
  for (let i = 0; i < y.length; i++) {
    if (y[i] === 1) {
      positives.push(X[i]);
    } else {
      negatives.push(X[i]);
    }
  }

  // Determine smaller class
  const minCount = Math.min(positives.length, negatives.length);

  // Undersample majority class
  const balancedX = [];
  const balancedY = [];

  // Shuffle and take equal amounts
  shuffleArray(positives);
  shuffleArray(negatives);

  for (let i = 0; i < minCount; i++) {
    balancedX.push(positives[i]);
    balancedY.push(1);
    balancedX.push(negatives[i]);
    balancedY.push(0);
  }

  return { X: balancedX, y: balancedY };
}

/**
 * Fisher-Yates shuffle (standalone function)
 */
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/**
 * Evaluate classifier performance
 * @param {LogisticRegressionClassifier} classifier
 * @param {Array<Float32Array>} X - Test embeddings
 * @param {Array<number>} y - True labels
 * @returns {Object} Metrics (accuracy, precision, recall, F1)
 */
export function evaluateClassifier(classifier, X, y, threshold = 0.5) {
  let tp = 0, fp = 0, tn = 0, fn = 0;

  for (let i = 0; i < X.length; i++) {
    const prob = classifier.predict(X[i]);
    const predicted = prob >= threshold ? 1 : 0;
    const actual = y[i];

    if (predicted === 1 && actual === 1) tp++;
    else if (predicted === 1 && actual === 0) fp++;
    else if (predicted === 0 && actual === 0) tn++;
    else if (predicted === 0 && actual === 1) fn++;
  }

  const accuracy = (tp + tn) / (tp + fp + tn + fn);
  const precision = tp / (tp + fp) || 0;
  const recall = tp / (tp + fn) || 0;
  const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;

  return {
    accuracy,
    precision,
    recall,
    f1,
    tp, fp, tn, fn
  };
}

