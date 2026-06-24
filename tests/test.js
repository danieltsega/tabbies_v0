// Tabbies - Test Suite Implementation

const TEST_URL_A = chrome.runtime.getURL("popup.html");
const TEST_URL_B = chrome.runtime.getURL("anchor.html");

const tests = [
  {
    id: "bg-connection",
    name: "Background Worker Connection",
    desc: "Verifies the background script can receive message queries",
    fn: async (log) => {
      log("Sending check message to background service worker...");
      try {
        // Send a message that we expect will trigger handleMessage
        // We can use focusActiveTab with an invalid ID to verify response logic is working
        const res = await chrome.runtime.sendMessage({ action: "focusActiveTab", savedTabId: "non-existent" });
        log("Received response: " + JSON.stringify(res));
        throw new Error("Should have thrown error for non-existent tab");
      } catch (e) {
        if (e.message.includes("Saved tab not found")) {
          log("Worker replied correctly: " + e.message);
          return true;
        }
        throw e;
      }
    }
  },
  {
    id: "window-lifecycle",
    name: "Background Storage Window Creation",
    desc: "Verifies the Tabbies background storage window can be created and minimized",
    fn: async (log) => {
      // Clear previous window state if any
      await chrome.storage.local.set({ storageWindowId: null });
      log("Triggering save tab to initialize storage window...");
      
      // We will create a temp tab to save/shelve
      const tempTab = await chrome.tabs.create({ url: TEST_URL_B, active: false });
      log(`Temp tab created: ID ${tempTab.id}`);
      
      const res = await chrome.runtime.sendMessage({
        action: "shelveActiveTab",
        tabId: tempTab.id,
        categoryId: "test-cat"
      });
      log("Save response: " + JSON.stringify(res));
      
      if (!res.success) throw new Error("Shelving failed: " + res.error);
      
      // Verify storage window exists
      const data = await chrome.storage.local.get("storageWindowId");
      const storageWindowId = data.storageWindowId;
      log(`Storage window ID in storage: ${storageWindowId}`);
      
      if (!storageWindowId) throw new Error("storageWindowId not saved in local storage");
      
      const storageWin = await chrome.windows.get(storageWindowId, { populate: true });
      log(`Retrieved storage window. State: ${storageWin.state}`);
      
      const hasAnchor = storageWin.tabs.some(t => t.url && t.url.includes("anchor.html"));
      log(`Anchor tab present in storage window: ${hasAnchor}`);
      
      if (!hasAnchor) throw new Error("Anchor tab was not created in storage window");
      
      // Clean up tab
      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId: res.tab.id });
      return true;
    }
  },
  {
    id: "shelve-unshelve",
    name: "Tab Shelving & Unshelving (Zero-Reload)",
    desc: "Verifies shelving a tab moves it without reloading, and unshelving restores it",
    fn: async (log) => {
      // Create a test tab
      const testTab = await chrome.tabs.create({ url: TEST_URL_A, active: false });
      log(`Created test tab: ID ${testTab.id}`);
      
      // Shelve the tab
      log("Shelving tab to background storage window...");
      const shelveRes = await chrome.runtime.sendMessage({
        action: "shelveActiveTab",
        tabId: testTab.id,
        categoryId: "test-cat"
      });
      
      if (!shelveRes.success) throw new Error("Shelve action failed: " + shelveRes.error);
      
      // Verify tab state is "hot"
      const savedTabId = shelveRes.tab.id;
      let savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      let savedTab = savedTabs.find(t => t.id === savedTabId);
      log(`Saved tab status: ${savedTab.status}, activeTabId: ${savedTab.activeTabId}`);
      
      if (savedTab.status !== "hot") throw new Error("Tab status is not 'hot'");
      
      // Verify it lives in the storage window
      const storageWindowId = (await chrome.storage.local.get("storageWindowId")).storageWindowId;
      const chromeTab = await chrome.tabs.get(testTab.id);
      log(`Chrome reports tab lives in window ID: ${chromeTab.windowId}`);
      if (chromeTab.windowId !== storageWindowId) throw new Error("Tab is not in the storage window");
      
      // Unshelve it back
      log("Unshelving tab back to main window...");
      const unshelveRes = await chrome.runtime.sendMessage({
        action: "unshelveTab",
        savedTabId
      });
      
      if (!unshelveRes.success) throw new Error("Unshelve action failed: " + unshelveRes.error);
      
      // Check status is now active
      savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      savedTab = savedTabs.find(t => t.id === savedTabId);
      log(`Saved tab status after unshelve: ${savedTab.status}`);
      if (savedTab.status !== "active") throw new Error("Tab status is not 'active'");
      
      // Verify it left the storage window
      const updatedChromeTab = await chrome.tabs.get(testTab.id);
      log(`Chrome reports tab now lives in window ID: ${updatedChromeTab.windowId}`);
      if (updatedChromeTab.windowId === storageWindowId) throw new Error("Tab is still in the storage window");
      
      // Clean up tab
      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId });
      return true;
    }
  },
  {
    id: "close-transitions-cold",
    name: "User Closing Active Tab -> Cold Storage",
    desc: "Verifies that closing a saved tab in Chrome transitions it to cold storage",
    fn: async (log) => {
      // Create and save an active tab
      const testTab = await chrome.tabs.create({ url: TEST_URL_B, active: false });
      log(`Created test tab: ID ${testTab.id}`);
      
      const saveRes = await chrome.runtime.sendMessage({
        action: "saveActiveTab",
        tabId: testTab.id,
        categoryId: "test-cat"
      });
      
      const savedTabId = saveRes.tab.id;
      log(`Tab saved with ID: ${savedTabId}`);
      
      // Close the tab manually
      log("Simulating user closing the tab...");
      await chrome.tabs.remove(testTab.id);
      
      // Wait a moment for background events to fire
      await new Promise(r => setTimeout(r, 800));
      
      // Verify status is cold and activeTabId is null
      const savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const savedTab = savedTabs.find(t => t.id === savedTabId);
      log(`Saved tab status after close: ${savedTab.status}, activeTabId: ${savedTab.activeTabId}`);
      
      if (savedTab.status !== "cold") throw new Error("Tab status did not transition to 'cold'");
      if (savedTab.activeTabId !== null) throw new Error("activeTabId was not set to null");
      
      // Clean up
      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId });
      return true;
    }
  },
  {
    id: "open-cold-tab",
    name: "Reopening Cold Tab",
    desc: "Verifies that clicking a cold tab opens a new tab and sets status to active",
    fn: async (log) => {
      // Setup a cold tab
      const now = Date.now();
      const coldTab = {
        id: "test_cold_" + now,
        categoryId: "test-cat",
        url: TEST_URL_A,
        title: "Example Title",
        favIconUrl: "",
        status: "cold",
        activeTabId: null,
        savedAt: now
      };
      
      let savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      savedTabs.push(coldTab);
      await chrome.storage.local.set({ savedTabs });
      log("Cold tab injected into storage");
      
      // Open the cold tab
      log("Sending openColdTab message...");
      const res = await chrome.runtime.sendMessage({
        action: "openColdTab",
        savedTabId: coldTab.id
      });
      
      if (!res.success) throw new Error("Failed to open cold tab: " + res.error);
      log(`Cold tab opened. New chrome tab ID: ${res.tab.activeTabId}`);
      
      // Verify tab is active and open
      savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const updatedTab = savedTabs.find(t => t.id === coldTab.id);
      log(`Updated tab status: ${updatedTab.status}, activeTabId: ${updatedTab.activeTabId}`);
      
      if (updatedTab.status !== "active") throw new Error("Tab status did not update to 'active'");
      if (!updatedTab.activeTabId) throw new Error("activeTabId was not updated");
      
      // Verify tab actually exists in chrome
      const tabInfo = await chrome.tabs.get(updatedTab.activeTabId);
      log(`Chrome verified tab is open with URL: ${tabInfo.url}`);
      
      // Clean up
      await chrome.tabs.remove(updatedTab.activeTabId);
      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId: coldTab.id });
      return true;
    }
  },
  {
    id: "storage-win-closure",
    name: "Storage Window Closure Handling",
    desc: "Verifies closing the background window transitions all hot tabs to cold",
    fn: async (log) => {
      // Ensure we have a storage window
      const storageWindowId = await chrome.runtime.sendMessage({ action: "shelveActiveTab", tabId: (await chrome.tabs.create({url: TEST_URL_A, active: false})).id, categoryId: "test" })
        .then(async (res) => {
          const data = await chrome.storage.local.get("storageWindowId");
          return data.storageWindowId;
        });
      
      log(`Active storage window ID: ${storageWindowId}`);
      
      // Create a second tab and shelve it
      const tabToShelve = await chrome.tabs.create({ url: TEST_URL_B, active: false });
      const shelveRes = await chrome.runtime.sendMessage({
        action: "shelveActiveTab",
        tabId: tabToShelve.id,
        categoryId: "test-cat"
      });
      const savedTabId = shelveRes.tab.id;
      log(`Shelved second tab: ${savedTabId}`);
      
      // Close the storage window
      log("Closing the background storage window...");
      await chrome.windows.remove(storageWindowId);
      
      // Wait a moment for background events to fire
      await new Promise(r => setTimeout(r, 800));
      
      // Verify storage window ID is reset and tab status is cold
      const data = await chrome.storage.local.get(["storageWindowId", "savedTabs"]);
      log(`storageWindowId in local storage after closure: ${data.storageWindowId}`);
      
      if (data.storageWindowId !== null) throw new Error("storageWindowId was not reset to null");
      
      const tab = data.savedTabs.find(t => t.id === savedTabId);
      log(`Saved tab status after window closure: ${tab.status}`);
      if (tab.status !== "cold") throw new Error("Tab status did not transition to 'cold'");
      
      // Clean up saved tabs
      const cleanedTabs = data.savedTabs.filter(t => t.id !== savedTabId);
      await chrome.storage.local.set({ savedTabs: cleanedTabs });
      return true;
    }
  },
  // === Category Move Tests ===
  {
    id: "move-tab-to-category",
    name: "Move Saved Tab to Different Category",
    desc: "Verifies moving a saved tab to another category updates its categoryId",
    fn: async (log) => {
      const catRes = await chrome.runtime.sendMessage({ action: "createCategory", name: "Move Test Cat", emoji: "📁", color: "#3b82f6" });
      const catId = catRes.category.id;
      log(`Created category: ${catId}`);

      const testTab = await chrome.tabs.create({ url: TEST_URL_A, active: false });
      const saveRes = await chrome.runtime.sendMessage({ action: "saveActiveTab", tabId: testTab.id, categoryId: "initial-cat" });
      const savedTabId = saveRes.tab.id;
      log(`Saved tab: ${savedTabId} with categoryId: "initial-cat"`);

      const moveRes = await chrome.runtime.sendMessage({ action: "updateSavedTab", savedTabId, updates: { categoryId: catId } });
      if (!moveRes.success) throw new Error("Move action failed: " + moveRes.error);

      const savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const movedTab = savedTabs.find(t => t.id === savedTabId);
      log(`Tab categoryId after move: "${movedTab.categoryId}"`);
      if (movedTab.categoryId !== catId) throw new Error(`categoryId is "${movedTab.categoryId}", expected "${catId}"`);

      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId });
      await chrome.tabs.remove(testTab.id);
      await chrome.runtime.sendMessage({ action: "deleteCategory", id: catId });
      return true;
    }
  },
  {
    id: "move-tab-to-no-category",
    name: "Move Saved Tab to No Category",
    desc: "Verifies setting a tab's categoryId to null removes it from its category",
    fn: async (log) => {
      const testTab = await chrome.tabs.create({ url: TEST_URL_B, active: false });
      const saveRes = await chrome.runtime.sendMessage({ action: "saveActiveTab", tabId: testTab.id, categoryId: "temp-cat-for-move-test" });
      const savedTabId = saveRes.tab.id;
      log(`Saved tab with categoryId: "temp-cat-for-move-test"`);

      const moveRes = await chrome.runtime.sendMessage({ action: "updateSavedTab", savedTabId, updates: { categoryId: null } });
      if (!moveRes.success) throw new Error("Move to no-category failed: " + moveRes.error);

      const savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const movedTab = savedTabs.find(t => t.id === savedTabId);
      log(`Tab categoryId after move: "${movedTab.categoryId}"`);
      if (movedTab.categoryId !== null) throw new Error(`categoryId is "${movedTab.categoryId}", expected null`);

      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId });
      await chrome.tabs.remove(testTab.id);
      return true;
    }
  },
  {
    id: "move-tab-preserves-data",
    name: "Move Tab Preserves Other Fields",
    desc: "Verifies that title, url, favIconUrl, and status remain unchanged when moving categories",
    fn: async (log) => {
      const testTab = await chrome.tabs.create({ url: TEST_URL_A, active: false });
      const saveRes = await chrome.runtime.sendMessage({ action: "saveActiveTab", tabId: testTab.id, categoryId: "preserve-test-cat" });
      const savedTabId = saveRes.tab.id;
      const originalTitle = saveRes.tab.title;
      const originalUrl = saveRes.tab.url;
      const originalFavIcon = saveRes.tab.favIconUrl;
      const originalStatus = saveRes.tab.status;
      log(`Original: title="${originalTitle}", status="${originalStatus}"`);

      await chrome.runtime.sendMessage({ action: "updateSavedTab", savedTabId, updates: { categoryId: "new-category-for-preserve-test" } });

      const savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const updatedTab = savedTabs.find(t => t.id === savedTabId);
      log(`After move: title="${updatedTab.title}", status="${updatedTab.status}", categoryId="${updatedTab.categoryId}"`);

      if (updatedTab.title !== originalTitle) throw new Error(`title changed from "${originalTitle}" to "${updatedTab.title}"`);
      if (updatedTab.url !== originalUrl) throw new Error(`url changed from "${originalUrl}" to "${updatedTab.url}"`);
      if (updatedTab.favIconUrl !== originalFavIcon) throw new Error(`favIconUrl changed from "${originalFavIcon}" to "${updatedTab.favIconUrl}"`);
      if (updatedTab.status !== originalStatus) throw new Error(`status changed from "${originalStatus}" to "${updatedTab.status}"`);
      if (updatedTab.categoryId !== "new-category-for-preserve-test") throw new Error(`categoryId is "${updatedTab.categoryId}", expected "new-category-for-preserve-test"`);

      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId });
      await chrome.tabs.remove(testTab.id);
      return true;
    }
  },
  {
    id: "move-nonexistent-tab",
    name: "Move Non-Existent Tab Returns Error",
    desc: "Verifies that updateSavedTab throws when the savedTabId does not exist",
    fn: async (log) => {
      try {
        await chrome.runtime.sendMessage({ action: "updateSavedTab", savedTabId: "no-such-tab-id", updates: { categoryId: "cat" } });
        throw new Error("Should have thrown for non-existent tab");
      } catch (e) {
        if (e.message.includes("Saved tab not found")) {
          log("Correctly rejected: " + e.message);
          return true;
        }
        throw e;
      }
    }
  },
  {
    id: "update-forbidden-field",
    name: "Update Forbidden Field Is Rejected",
    desc: "Verifies that updateSavedTab rejects attempts to modify status, id, or activeTabId",
    fn: async (log) => {
      const testTab = await chrome.tabs.create({ url: TEST_URL_B, active: false });
      const saveRes = await chrome.runtime.sendMessage({ action: "saveActiveTab", tabId: testTab.id, categoryId: "forbidden-test" });
      const savedTabId = saveRes.tab.id;
      log(`Saved tab: ${savedTabId}`);

      try {
        await chrome.runtime.sendMessage({ action: "updateSavedTab", savedTabId, updates: { status: "cold" } });
        throw new Error("Should have rejected status update");
      } catch (e) {
        if (e.message.includes("Cannot update field: status")) {
          log("Correctly rejected status update: " + e.message);
        } else {
          throw e;
        }
      }

      try {
        await chrome.runtime.sendMessage({ action: "updateSavedTab", savedTabId, updates: { id: "new-id" } });
        throw new Error("Should have rejected id update");
      } catch (e) {
        if (e.message.includes("Cannot update field: id")) {
          log("Correctly rejected id update: " + e.message);
        } else {
          throw e;
        }
      }

      const savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const tab = savedTabs.find(t => t.id === savedTabId);
      if (tab.status !== "active") throw new Error("Status was modified despite rejection");
      if (tab.id !== savedTabId) throw new Error("ID was modified despite rejection");
      log("Tab state unchanged after rejected updates");

      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId });
      await chrome.tabs.remove(testTab.id);
      return true;
    }
  },
  {
    id: "update-empty-payload-rejected",
    name: "Update With Null Updates Is Rejected",
    desc: "Verifies that updateSavedTab rejects a null updates payload",
    fn: async (log) => {
      try {
        await chrome.runtime.sendMessage({ action: "updateSavedTab", savedTabId: "any-id", updates: null });
        throw new Error("Should have rejected null updates");
      } catch (e) {
        if (e.message.includes("Invalid updates payload")) {
          log("Correctly rejected null updates: " + e.message);
          return true;
        }
        throw e;
      }
    }
  },
  // === Category-Aware Save/Shelve Tests ===
  {
    id: "category-aware-save",
    name: "Category-Aware Save Uses Selected Category",
    desc: "Verifies that saving a tab respects the selected save category ID",
    fn: async (log) => {
      const catRes = await chrome.runtime.sendMessage({ action: "createCategory", name: "SaveTarget", emoji: "🎯", color: "#ef4444" });
      const catId = catRes.category.id;
      log(`Created category: ${catId}`);

      const testTab = await chrome.tabs.create({ url: TEST_URL_A, active: false });
      const saveRes = await chrome.runtime.sendMessage({ action: "saveActiveTab", tabId: testTab.id, categoryId: catId });
      const savedTabId = saveRes.tab.id;
      log(`Saved tab with categoryId: "${saveRes.tab.categoryId}"`);

      if (saveRes.tab.categoryId !== catId) throw new Error(`categoryId is "${saveRes.tab.categoryId}", expected "${catId}"`);

      const savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const tab = savedTabs.find(t => t.id === savedTabId);
      if (tab.categoryId !== catId) throw new Error("categoryId mismatch in storage after save");

      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId });
      await chrome.tabs.remove(testTab.id);
      await chrome.runtime.sendMessage({ action: "deleteCategory", id: catId });
      return true;
    }
  },
  {
    id: "category-aware-save-no-category",
    name: "Category-Aware Save With No Category",
    desc: "Verifies that saving a tab with null categoryId produces an uncategorized tab",
    fn: async (log) => {
      const testTab = await chrome.tabs.create({ url: TEST_URL_B, active: false });
      const saveRes = await chrome.runtime.sendMessage({ action: "saveActiveTab", tabId: testTab.id, categoryId: null });
      const savedTabId = saveRes.tab.id;
      log(`Saved tab with categoryId: "${saveRes.tab.categoryId}"`);

      if (saveRes.tab.categoryId !== null) throw new Error(`categoryId is not null: "${saveRes.tab.categoryId}"`);

      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId });
      await chrome.tabs.remove(testTab.id);
      return true;
    }
  },
  {
    id: "open-all-cold-tabs",
    name: "Open All Cold Tabs in Category",
    desc: "Verifies that openAllColdTabs opens every cold tab and sets status to active",
    fn: async (log) => {
      const catRes = await chrome.runtime.sendMessage({ action: "createCategory", name: "BulkRestore", emoji: "📦", color: "#22c55e" });
      const catId = catRes.category.id;
      log(`Created category: ${catId}`);

      const now = Date.now();
      const coldTabs = [
        { id: "bulk_test_1_" + now, categoryId: catId, url: TEST_URL_A, title: "Bulk 1", favIconUrl: "", status: "cold", activeTabId: null, savedAt: now },
        { id: "bulk_test_2_" + now, categoryId: catId, url: TEST_URL_B, title: "Bulk 2", favIconUrl: "", status: "cold", activeTabId: null, savedAt: now }
      ];
      let savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      savedTabs.push(...coldTabs);
      await chrome.storage.local.set({ savedTabs });
      log("Injected 2 cold tabs into category");

      const res = await chrome.runtime.sendMessage({ action: "openAllColdTabs", categoryId: catId });
      if (!res.success) throw new Error("openAllColdTabs failed: " + res.error);
      log(`Opened ${res.opened.length} tabs`);

      if (res.opened.length !== 2) throw new Error(`Expected 2 opened tabs, got ${res.opened.length}`);

      savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const tab1 = savedTabs.find(t => t.id === coldTabs[0].id);
      const tab2 = savedTabs.find(t => t.id === coldTabs[1].id);
      if (tab1.status !== "active") throw new Error("Tab 1 status is not active: " + tab1.status);
      if (tab2.status !== "active") throw new Error("Tab 2 status is not active: " + tab2.status);
      if (!tab1.activeTabId) throw new Error("Tab 1 activeTabId is null");
      if (!tab2.activeTabId) throw new Error("Tab 2 activeTabId is null");
      log("Both cold tabs are now active with valid chrome tab IDs");

      await chrome.tabs.remove(tab1.activeTabId);
      await chrome.tabs.remove(tab2.activeTabId);
      const cleaned = savedTabs.filter(t => !coldTabs.some(ct => ct.id === t.id));
      await chrome.storage.local.set({ savedTabs: cleaned });
      await chrome.runtime.sendMessage({ action: "deleteCategory", id: catId });
      return true;
    }
  },
  {
    id: "open-all-cold-tabs-empty",
    name: "Open All Cold Tabs Returns Empty for No-Op",
    desc: "Verifies that openAllColdTabs returns an empty array when no cold tabs exist",
    fn: async (log) => {
      const catRes = await chrome.runtime.sendMessage({ action: "createCategory", name: "EmptyCat", emoji: "🫙", color: "#6b7280" });
      const catId = catRes.category.id;
      log(`Created empty category: ${catId}`);

      const res = await chrome.runtime.sendMessage({ action: "openAllColdTabs", categoryId: catId });
      if (!res.success) throw new Error("openAllColdTabs failed: " + res.error);
      log(`Opened ${res.opened.length} tabs (expected 0)`);

      if (res.opened.length !== 0) throw new Error(`Expected 0 opened tabs, got ${res.opened.length}`);

      await chrome.runtime.sendMessage({ action: "deleteCategory", id: catId });
      return true;
    }
  },
  {
    id: "save-to-nonexistent-category",
    name: "Save Tab to Non-Existent Category",
    desc: "Verifies that saving a tab with a bogus categoryId does not throw",
    fn: async (log) => {
      const testTab = await chrome.tabs.create({ url: TEST_URL_A, active: false });
      const saveRes = await chrome.runtime.sendMessage({ action: "saveActiveTab", tabId: testTab.id, categoryId: "this-category-does-not-exist" });
      if (!saveRes.success) throw new Error("Save failed: " + saveRes.error);
      log(`Saved tab with categoryId: "${saveRes.tab.categoryId}"`);

      if (saveRes.tab.categoryId !== "this-category-does-not-exist") throw new Error("categoryId was modified");

      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId: saveRes.tab.id });
      await chrome.tabs.remove(testTab.id);
      return true;
    }
  }
];

// UI Rendering and execution logic
document.addEventListener("DOMContentLoaded", () => {
  const testList = document.getElementById("test-list");
  const runBtn = document.getElementById("run-btn");
  const passedCount = document.getElementById("passed-count");
  const failedCount = document.getElementById("failed-count");
  const logBox = document.getElementById("log-box");
  
  function appendLog(msg) {
    logBox.textContent += msg + "\n";
    logBox.scrollTop = logBox.scrollHeight;
  }
  
  // Render tests initially
  tests.forEach(test => {
    const el = document.createElement("div");
    el.className = "test-item";
    el.id = `test-item-${test.id}`;
    el.innerHTML = `
      <div class="test-info">
        <span class="test-name">${test.name}</span>
        <span class="test-desc">${test.desc}</span>
      </div>
      <span class="test-status status-pending" id="status-${test.id}">Pending</span>
    `;
    testList.appendChild(el);
  });
  
  async function runSuite() {
    runBtn.disabled = true;
    logBox.textContent = "Starting test suite execution...\n";
    passedCount.textContent = "0";
    failedCount.textContent = "0";
    
    let passed = 0;
    let failed = 0;
    const logOutput = [];
    
    function testLog(msg) {
      appendLog(msg);
      logOutput.push(msg);
    }
    
    // Reset all badges
    tests.forEach(t => {
      const badge = document.getElementById(`status-${t.id}`);
      badge.className = "test-status status-pending";
      badge.textContent = "Pending";
    });
    
    for (const test of tests) {
      const badge = document.getElementById(`status-${test.id}`);
      badge.className = "test-status status-running";
      badge.textContent = "Running";
      testLog(`\n[RUNNING] ${test.name}`);
      
      try {
        const success = await test.fn(testLog);
        if (success) {
          badge.className = "test-status status-passed";
          badge.textContent = "Passed";
          testLog(`[PASSED] ${test.name}`);
          passed++;
          passedCount.textContent = passed;
        } else {
          throw new Error("Test returned false");
        }
      } catch (e) {
        badge.className = "test-status status-failed";
        badge.textContent = "Failed";
        testLog(`[FAILED] ${test.name}: ${e.message}`);
        if (e.stack) testLog(e.stack);
        failed++;
        failedCount.textContent = failed;
      }
    }
    
    testLog(`\nExecution complete. Passed: ${passed}, Failed: ${failed}`);
    runBtn.disabled = false;
    return { passed, failed, logs: logOutput };
  }

  runBtn.addEventListener("click", () => runSuite());

  const isAutoRun = new URLSearchParams(window.location.search).get("autorun") === "true";
  if (isAutoRun) {
    appendLog("Autorun query detected. Initiating suite in 1 second...");
    setTimeout(async () => {
      const results = await runSuite();
      appendLog("Posting results to local server...");
      try {
        await fetch("http://localhost:3000/results", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(results)
        });
      } catch (e) {
        appendLog("Failed to post results: " + e.message);
      }
    }, 1000);
  }
});
