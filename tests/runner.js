// Tabbies - Test Runner Script
// Launches Chromium headlessly, serves a temporary results listener, and returns test statuses.

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 3000;
const EXTENSION_ID = "fjpkoelncdbekapkebmodcfbnjngboca";
const TEST_URL = `chrome-extension://${EXTENSION_ID}/tests/test.html?autorun=true`;
const CHROMIUM_PATH = "/usr/bin/chromium";

async function run() {
  let server;
  let chromiumProcess;
  
  // 1. Start HTTP Server to listen for test results
  const testPromise = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/results") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          try {
            const results = JSON.parse(body);
            resolve(results);
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("OK");
          } catch (e) {
            reject(new Error("Failed to parse test results: " + e.message));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(PORT, (err) => {
      if (err) reject(err);
    });
  });

  console.log(`Test server listening on port ${PORT}...`);

  const userDataDir = path.resolve(`/tmp/tabbies-test-profile-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`);

  // 2. Launch Chromium headlessly with the extension loaded
  console.log("Launching Chromium headlessly...");
  const args = [
    `--load-extension=${path.resolve(__dirname, "..")}`,
    `--disable-extensions-except=${path.resolve(__dirname, "..")}`,
    `--user-data-dir=${userDataDir}`,
    `--no-sandbox`,
    `--headless=new`,
    TEST_URL
  ];

  chromiumProcess = spawn(CHROMIUM_PATH, args);

  chromiumProcess.stderr.on("data", (data) => {
    // Suppress verbose browser output but can debug if needed
  });

  // 3. Set a timeout for tests execution
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error("Test execution timed out after 30 seconds"));
    }, 30000);
  });

  try {
    // Race test completion against timeout
    const results = await Promise.race([testPromise, timeoutPromise]);
    
    console.log("\n--- TEST LOGS ---");
    results.logs.forEach(log => console.log(log));
    console.log("-----------------\n");

    console.log(`Test Execution Finished.`);
    console.log(`Passed: ${results.passed}, Failed: ${results.failed}`);

    if (results.failed > 0) {
      console.error(`${results.failed} tests failed!`);
      process.exit(1);
    } else {
      console.log("All tests passed successfully!");
      process.exit(0);
    }
  } catch (e) {
    console.error("Test execution failed:", e.message);
    process.exit(1);
  } finally {
    if (server) server.close();
    if (chromiumProcess) chromiumProcess.kill();
    try {
      if (fs.existsSync(userDataDir)) {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error("Failed to clean up user data directory:", err.message);
    }
  }
}

run();
