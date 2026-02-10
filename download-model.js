// download-model.js
// Pre-download MiniLM model files to bundle with extension
import dns from "dns";

dns.setDefaultResultOrder("ipv4first");

const agent = new https.Agent({
  lookup: (hostname, options, cb) => {
    if (hostname === "cdn-lfs.huggingface.co") {
      // CloudFront edge IP (stable)
      cb(null, "108.138.51.21", 4);
    } else {
      dns.lookup(hostname, options, cb);
    }
  }
});

import fs from "fs";
import path from "path";
import https from "https";
import http from "http";

const MODEL_DIR = "./src/models/all-minilm-l6-v2";
const FILES_TO_DOWNLOAD = [
  { 
    url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json",
    name: "tokenizer.json"
  },
  {
    url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/config.json",
    name: "config.json"
  },
  {
    url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/ort-quant.onnx",
    name: "ort-quant.onnx"
  },
];

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    let redirectCount = 0;
    const maxRedirects = 5;
    
    const doRequest = (requestUrl) => {
      protocol.get(requestUrl, { timeout: 30000 }, (response) => {
        // Handle redirects
        if ((response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 303) && response.headers.location) {
          redirectCount++;
          if (redirectCount > maxRedirects) {
            reject(new Error(`Too many redirects for ${url}`));
            return;
          }
          file.close();
          fs.unlink(dest, () => {}); // Delete empty file
          doRequest(response.headers.location);
          return;
        }
        
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
          return;
        }
        
        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
        file.on("error", (err) => {
          file.close();
          fs.unlink(dest, () => {}); // Delete partial file
          reject(err);
        });
      }).on("error", (err) => {
        file.close();
        fs.unlink(dest, () => {});
        reject(err);
      }).on("timeout", () => {
        file.close();
        fs.unlink(dest, () => {});
        reject(new Error(`Download timeout for ${url}`));
      });
    };
    
    doRequest(url);
  });
}

async function main() {
  try {
    // Create model directory
    if (!fs.existsSync(MODEL_DIR)) {
      fs.mkdirSync(MODEL_DIR, { recursive: true });
      console.log(`Created directory: ${MODEL_DIR}`);
    }

    console.log("Downloading MiniLM-L6-v2 model files...");
    
    for (const file of FILES_TO_DOWNLOAD) {
      const filename = file.name;
      const url = file.url;
      const dest = path.join(MODEL_DIR, filename);
      
      // Always delete empty files and redownload
      if (fs.existsSync(dest)) {
        const size = fs.statSync(dest).size;
        if (size === 0) {
          console.log(`Removing empty file: ${filename}`);
          fs.unlinkSync(dest);
        } else {
          console.log(`✓ Already exists: ${filename} (${(size / 1024 / 1024).toFixed(2)} MB)`);
          continue;
        }
      }
      
      console.log(`Downloading: ${filename}...`);
      await downloadFile(url, dest);
      const size = fs.statSync(dest).size;
      console.log(`✓ Downloaded ${filename} (${(size / 1024 / 1024).toFixed(2)} MB)`);
    }
    
    console.log("\n✅ Model files downloaded successfully!");
    console.log(`Location: ${path.resolve(MODEL_DIR)}`);
  } catch (err) {
    console.error("❌ Download failed:", err.message);
    process.exit(1);
  }
}

main();
