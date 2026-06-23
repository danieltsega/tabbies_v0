// Tabbies - Test Runner Script
// Launches Chromium headlessly, serves a temporary results listener, and returns test statuses.

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 3000;
const CHROMIUM_PATH = "/usr/bin/chromium";

async function ensureDisplay() {
  if (process.env.DISPLAY) return null;
  const xvfb = spawn("Xvfb", [":99", "-screen", "0", "1920x1080x24"], { stdio: "ignore" });
  await new Promise(r => setTimeout(r, 500));
  process.env.DISPLAY = ":99";
  return xvfb;
}

async function run() {
  let server;
  let chromiumProcess;
  let xvfbProcess;

  const userDataDir = path.resolve(`/tmp/tabbies-test-profile-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`);

  try {
    xvfbProcess = await ensureDisplay();

    // 1. Detect extension ID by starting a temporary Chromium process
    console.log("Detecting extension ID...");
    const tempProc = spawn(CHROMIUM_PATH, [
      `--load-extension=${path.resolve(__dirname, "..")}`,
      `--disable-extensions-except=${path.resolve(__dirname, "..")}`,
      `--user-data-dir=${userDataDir}`,
      `--no-sandbox`,
      `--headless=new`
    ]);

    // Wait 3 seconds for it to register the extension and write preferences
    await new Promise(r => setTimeout(r, 3000));
    tempProc.kill();

    // Read preferences to find the extension ID
    const prefsPath = path.join(userDataDir, "Default", "Preferences");
    if (!fs.existsSync(prefsPath)) {
      throw new Error("Preferences file not found at " + prefsPath);
    }

    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
    const settings = prefs.extensions?.settings || {};
    let extensionId = null;
    for (const [id, value] of Object.entries(settings)) {
      if (value.path && value.path.includes("tabbies")) {
        extensionId = id;
        break;
      }
    }

    if (!extensionId) {
      throw new Error("Failed to detect extension ID in preferences");
    }

    console.log(`Detected extension ID: ${extensionId}`);
    const testUrl = `chrome-extension://${extensionId}/tests/test.html?autorun=true`;

    // 2. Start HTTP Server to listen for test results
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

    // 3. Launch Chromium in headful mode on the virtual display to run tests
    console.log("Launching Chromium on virtual display...");
    const args = [
      `--load-extension=${path.resolve(__dirname, "..")}`,
      `--disable-extensions-except=${path.resolve(__dirname, "..")}`,
      `--user-data-dir=${userDataDir}`,
      `--no-sandbox`,
      testUrl
    ];

    chromiumProcess = spawn(CHROMIUM_PATH, args);

    // Set a timeout for tests execution
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error("Test execution timed out after 30 seconds"));
      }, 30000);
    });

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
    if (xvfbProcess) xvfbProcess.kill();
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
