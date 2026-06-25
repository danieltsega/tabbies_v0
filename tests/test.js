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
  },
  // === Drag-and-Drop / Reorder Tests ===
  {
    id: "move-tab-within-category",
    name: "Move Tab Within Same Category",
    desc: "Verifies that moveTab reorders a tab within its category",
    fn: async (log) => {
      const catRes = await chrome.runtime.sendMessage({ action: "createCategory", name: "ReorderCat", emoji: "🔀", color: "#8b5cf6" });
      const catId = catRes.category.id;
      log(`Created category: ${catId}`);

      const tabs = [];
      for (let i = 1; i <= 3; i++) {
        const t = await chrome.tabs.create({ url: TEST_URL_A, active: false });
        const saveRes = await chrome.runtime.sendMessage({ action: "saveActiveTab", tabId: t.id, categoryId: catId });
        tabs.push(saveRes.tab);
        log(`Created tab ${i}: ${saveRes.tab.id}`);
      }

      const savedTabsBefore = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const idsBefore = savedTabsBefore.filter(t => t.categoryId === catId).map(t => t.id);
      log(`Order before: ${idsBefore.join(", ")}`);

      // Move the third tab to index 0 (global index within savedTabs)
      const moveRes = await chrome.runtime.sendMessage({
        action: "moveTab",
        savedTabId: tabs[2].id,
        targetIndex: 0
      });
      if (!moveRes.success) throw new Error("moveTab failed: " + moveRes.error);

      const savedTabsAfter = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const idsAfter = savedTabsAfter.filter(t => t.categoryId === catId).map(t => t.id);
      log(`Order after: ${idsAfter.join(", ")}`);

      if (idsAfter[0] !== tabs[2].id) throw new Error(`Expected first tab to be ${tabs[2].id}, got ${idsAfter[0]}`);

      for (const tab of tabs) {
        await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId: tab.id });
      }
      await chrome.runtime.sendMessage({ action: "deleteCategory", id: catId });
      return true;
    }
  },
  {
    id: "move-tab-to-different-category",
    name: "Move Tab Between Categories",
    desc: "Verifies that moveTab changes categoryId and places the tab in the target category",
    fn: async (log) => {
      const catARes = await chrome.runtime.sendMessage({ action: "createCategory", name: "CatA", emoji: "🅰️", color: "#ef4444" });
      const catBRes = await chrome.runtime.sendMessage({ action: "createCategory", name: "CatB", emoji: "🅱️", color: "#3b82f6" });
      const catA = catARes.category.id;
      const catB = catBRes.category.id;
      log(`Categories: A=${catA}, B=${catB}`);

      const tabA = await chrome.tabs.create({ url: TEST_URL_A, active: false });
      const saveRes = await chrome.runtime.sendMessage({ action: "saveActiveTab", tabId: tabA.id, categoryId: catA });
      log(`Saved tab in CatA: ${saveRes.tab.id}`);

      const moveRes = await chrome.runtime.sendMessage({
        action: "moveTab",
        savedTabId: saveRes.tab.id,
        newCategoryId: catB,
        targetIndex: 0
      });
      if (!moveRes.success) throw new Error("moveTab failed: " + moveRes.error);
      log(`Moved to CatB, new categoryId: ${moveRes.tab.categoryId}`);

      if (moveRes.tab.categoryId !== catB) throw new Error(`categoryId is "${moveRes.tab.categoryId}", expected "${catB}"`);

      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId: saveRes.tab.id });
      await chrome.tabs.remove(tabA.id);
      await chrome.runtime.sendMessage({ action: "deleteCategory", id: catA });
      await chrome.runtime.sendMessage({ action: "deleteCategory", id: catB });
      return true;
    }
  },
  {
    id: "reorder-categories",
    name: "Reorder Categories",
    desc: "Verifies that reorderCategories updates the category order in storage",
    fn: async (log) => {
      const ids = [];
      for (const name of ["First", "Second", "Third"]) {
        const res = await chrome.runtime.sendMessage({ action: "createCategory", name, emoji: "📁", color: "#6b7280" });
        ids.push(res.category.id);
      }
      log(`Created categories: ${ids.join(", ")}`);

      const reversed = [ids[2], ids[1], ids[0]];
      log(`Requesting order: ${reversed.join(", ")}`);
      const reorderRes = await chrome.runtime.sendMessage({ action: "reorderCategories", orderedIds: reversed });
      if (!reorderRes.success) throw new Error("reorderCategories failed");

      const cats = (await chrome.runtime.sendMessage({ action: "getAllData" })).data.categories;
      const orderAfter = cats.map(c => c.id);
      log(`Order after: ${orderAfter.join(", ")}`);

      if (orderAfter[0] !== ids[2] || orderAfter[1] !== ids[1] || orderAfter[2] !== ids[0]) {
        throw new Error(`Unexpected order: ${orderAfter.join(", ")}`);
      }

      for (const id of ids) {
        await chrome.runtime.sendMessage({ action: "deleteCategory", id });
      }
      return true;
    }
  },
  {
    id: "move-tab-index-zero",
    name: "Move Tab to Index Zero",
    desc: "Verifies that moving a tab to global index 0 places it at the very beginning",
    fn: async (log) => {
      const catRes = await chrome.runtime.sendMessage({ action: "createCategory", name: "IndexZero", emoji: "0️⃣", color: "#22c55e" });
      const catId = catRes.category.id;

      const tabInfos = [];
      for (let i = 1; i <= 2; i++) {
        const t = await chrome.tabs.create({ url: TEST_URL_B, active: false });
        const saveRes = await chrome.runtime.sendMessage({ action: "saveActiveTab", tabId: t.id, categoryId: catId });
        tabInfos.push(saveRes.tab);
      }

      // Move the second tab to index 0
      await chrome.runtime.sendMessage({ action: "moveTab", savedTabId: tabInfos[1].id, targetIndex: 0 });

      const savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const catTabs = savedTabs.filter(t => t.categoryId === catId);
      if (catTabs[0].id !== tabInfos[1].id) throw new Error(`Expected first tab to be ${tabInfos[1].id}, got ${catTabs[0].id}`);

      for (const tab of tabInfos) {
        await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId: tab.id });
      }
      await chrome.runtime.sendMessage({ action: "deleteCategory", id: catId });
      return true;
    }
  },
  // === Save All Tabs Tests ===
  {
    id: "save-all-tabs",
    name: "Save All Tabs in Window",
    desc: "Verifies saveAllTabs saves every valid tab in the given window",
    fn: async (log) => {
      const tab1 = await chrome.tabs.create({ url: TEST_URL_A, active: false });
      const tab2 = await chrome.tabs.create({ url: TEST_URL_B, active: false });
      log(`Created tabs: ${tab1.id} (win=${tab1.windowId}), ${tab2.id}`);

      const res = await chrome.runtime.sendMessage({
        action: "saveAllTabs",
        windowId: tab1.windowId,
        categoryId: "test-all-cat"
      });
      log(`saveAllTabs returned: count=${res.count}, success=${res.success}`);

      if (!res.success) throw new Error("saveAllTabs failed: " + res.error);
      if (res.count < 2) throw new Error(`Expected at least 2 tabs saved, got ${res.count}`);

      const savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const saved1 = savedTabs.find(t => t.activeTabId === tab1.id);
      const saved2 = savedTabs.find(t => t.activeTabId === tab2.id);
      if (!saved1) throw new Error("Tab 1 was not saved");
      if (!saved2) throw new Error("Tab 2 was not saved");
      if (saved1.categoryId !== "test-all-cat") throw new Error(`Tab 1 categoryId is "${saved1.categoryId}", expected "test-all-cat"`);
      if (saved1.status !== "active") throw new Error("Tab 1 status is not active");
      if (saved2.status !== "active") throw new Error("Tab 2 status is not active");
      log("Both tabs saved correctly with categoryId and active status");

      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId: saved1.id });
      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId: saved2.id });
      await chrome.tabs.remove(tab1.id);
      await chrome.tabs.remove(tab2.id);
      return true;
    }
  },
  {
    id: "save-all-tabs-no-duplicates",
    name: "Save All Tabs Deduplicates by activeTabId",
    desc: "Verifies that saving already-saved tabs updates rather than duplicates",
    fn: async (log) => {
      const tab = await chrome.tabs.create({ url: TEST_URL_A, active: false });
      const firstRes = await chrome.runtime.sendMessage({ action: "saveActiveTab", tabId: tab.id, categoryId: "first-cat" });
      const tabId = firstRes.tab.id;
      log(`Saved tab once: ${tabId}, categoryId: "first-cat"`);

      await chrome.runtime.sendMessage({
        action: "saveAllTabs",
        windowId: tab.windowId,
        categoryId: "second-cat"
      });
      log("Called saveAllTabs with categoryId: 'second-cat'");

      const savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const matches = savedTabs.filter(t => t.activeTabId === tab.id);
      log(`Matches for this activeTabId: ${matches.length}`);

      if (matches.length !== 1) throw new Error(`Expected 1 match, got ${matches.length}`);
      if (matches[0].id !== tabId) throw new Error("Tab ID changed on re-save");
      if (matches[0].categoryId !== "second-cat") throw new Error(`categoryId is "${matches[0].categoryId}", expected "second-cat"`);
      log("Tab was updated in place without duplication");

      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId: tabId });
      await chrome.tabs.remove(tab.id);
      return true;
    }
  },
  {
    id: "save-all-tabs-empty-window",
    name: "Save All Tabs With No Valid Tabs",
    desc: "Verifies saveAllTabs handles a window with no saveable tabs gracefully",
    fn: async (log) => {
      const res = await chrome.runtime.sendMessage({
        action: "saveAllTabs",
        windowId: -999,
        categoryId: "test"
      });
      log(`saveAllTabs on invalid window: count=${res.count}`);
      if (!res.success) throw new Error("saveAllTabs failed on invalid window: " + res.error);
      return true;
    }
  },
  // === Archive Category Tests ===
  {
    id: "archive-category-active",
    name: "Archive Active Tabs in Category",
    desc: "Verifies archiveCategory transitions active tabs to cold and closes their chrome tabs",
    fn: async (log) => {
      const catRes = await chrome.runtime.sendMessage({ action: "createCategory", name: "ArchiveTest", emoji: "🧊", color: "#3b82f6" });
      const catId = catRes.category.id;
      log(`Created category: ${catId}`);

      const tab = await chrome.tabs.create({ url: TEST_URL_A, active: false });
      const saveRes = await chrome.runtime.sendMessage({ action: "saveActiveTab", tabId: tab.id, categoryId: catId });
      const savedTabId = saveRes.tab.id;
      log(`Saved active tab: ${savedTabId}, status=active`);

      const archiveRes = await chrome.runtime.sendMessage({ action: "archiveCategory", categoryId: catId });
      log(`archiveCategory returned: archived=${archiveRes.archived}`);
      if (!archiveRes.success) throw new Error("archiveCategory failed: " + archiveRes.error);
      if (archiveRes.archived !== 1) throw new Error(`Expected 1 archived tab, got ${archiveRes.archived}`);

      const savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const archivedTab = savedTabs.find(t => t.id === savedTabId);
      if (!archivedTab) throw new Error("Saved tab not found after archive");
      if (archivedTab.status !== "cold") throw new Error(`Tab status is "${archivedTab.status}", expected "cold"`);
      if (archivedTab.activeTabId !== null) throw new Error("activeTabId was not set to null");
      log("Tab transitioned to cold with null activeTabId");

      try {
        await chrome.tabs.get(tab.id);
        throw new Error("Chrome tab should have been removed");
      } catch (e) {
        log("Chrome tab was successfully removed");
      }

      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId });
      await chrome.runtime.sendMessage({ action: "deleteCategory", id: catId });
      return true;
    }
  },
  {
    id: "archive-category-shelved",
    name: "Archive Shelved (Hot) Tabs in Category",
    desc: "Verifies archiveCategory transitions shelved tabs to cold and closes their chrome tabs",
    fn: async (log) => {
      const catRes = await chrome.runtime.sendMessage({ action: "createCategory", name: "ArchiveShelved", emoji: "🧊", color: "#ef4444" });
      const catId = catRes.category.id;
      log(`Created category: ${catId}`);

      const tab = await chrome.tabs.create({ url: TEST_URL_B, active: false });
      const shelveRes = await chrome.runtime.sendMessage({ action: "shelveActiveTab", tabId: tab.id, categoryId: catId });
      const savedTabId = shelveRes.tab.id;
      log(`Shelved tab: ${savedTabId}, status=hot`);

      const archiveRes = await chrome.runtime.sendMessage({ action: "archiveCategory", categoryId: catId });
      log(`archiveCategory returned: archived=${archiveRes.archived}`);
      if (!archiveRes.success) throw new Error("archiveCategory failed: " + archiveRes.error);
      if (archiveRes.archived !== 1) throw new Error(`Expected 1 archived tab, got ${archiveRes.archived}`);

      const savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const archivedTab = savedTabs.find(t => t.id === savedTabId);
      if (!archivedTab) throw new Error("Saved tab not found after archive");
      if (archivedTab.status !== "cold") throw new Error(`Tab status is "${archivedTab.status}", expected "cold"`);
      if (archivedTab.activeTabId !== null) throw new Error("activeTabId was not set to null");
      log("Shelved tab transitioned to cold");

      try {
        await chrome.tabs.get(tab.id);
        throw new Error("Chrome tab should have been removed");
      } catch (e) {
        log("Shelved chrome tab was successfully removed");
      }

      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId });
      await chrome.runtime.sendMessage({ action: "deleteCategory", id: catId });
      return true;
    }
  },
  {
    id: "archive-category-ignores-cold",
    name: "Archive Category Leaves Cold Tabs Untouched",
    desc: "Verifies archiveCategory does not affect already-cold tabs",
    fn: async (log) => {
      const catRes = await chrome.runtime.sendMessage({ action: "createCategory", name: "ArchiveCold", emoji: "🧊", color: "#22c55e" });
      const catId = catRes.category.id;
      log(`Created category: ${catId}`);

      const now = Date.now();
      const coldTab = {
        id: "archive_cold_test_" + now,
        categoryId: catId,
        url: TEST_URL_A,
        title: "Archive Cold Test",
        favIconUrl: "",
        status: "cold",
        activeTabId: null,
        savedAt: now
      };
      let savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      savedTabs.push(coldTab);
      await chrome.storage.local.set({ savedTabs });
      log("Injected cold tab into category");

      const archiveRes = await chrome.runtime.sendMessage({ action: "archiveCategory", categoryId: catId });
      log(`archiveCategory returned: archived=${archiveRes.archived}`);
      if (archiveRes.archived !== 0) throw new Error(`Expected 0 archived tabs, got ${archiveRes.archived}`);

      savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const tab = savedTabs.find(t => t.id === coldTab.id);
      if (tab.status !== "cold") throw new Error(`Cold tab status changed to "${tab.status}"`);
      log("Cold tab remained cold");

      const cleaned = savedTabs.filter(t => t.id !== coldTab.id);
      await chrome.storage.local.set({ savedTabs: cleaned });
      await chrome.runtime.sendMessage({ action: "deleteCategory", id: catId });
      return true;
    }
  },
  {
    id: "archive-category-nonexistent",
    name: "Archive Non-Existent Category Returns Success",
    desc: "Verifies archiveCategory with a non-existent category ID returns success with 0 archived",
    fn: async (log) => {
      const res = await chrome.runtime.sendMessage({ action: "archiveCategory", categoryId: "no-such-category-id" });
      log(`archiveCategory on non-existent category: archived=${res.archived}`);
      if (!res.success) throw new Error("archiveCategory failed: " + res.error);
      if (res.archived !== 0) throw new Error(`Expected 0 archived tabs, got ${res.archived}`);
      return true;
    }
  },
  // === Import / Export Tests ===
  {
    id: "import-data-replaces-existing",
    name: "Import Data Replaces Existing Tabs and Categories",
    desc: "Verifies importData replaces savedTabs and categories in storage",
    fn: async (log) => {
      const now = Date.now();
      const importData = {
        savedTabs: [
          { id: "imported_1_" + now, categoryId: null, url: TEST_URL_A, title: "Imported A", favIconUrl: "", status: "cold", activeTabId: null, savedAt: now },
          { id: "imported_2_" + now, categoryId: "imp-cat", url: TEST_URL_B, title: "Imported B", favIconUrl: "", status: "cold", activeTabId: null, savedAt: now }
        ],
        categories: [
          { id: "imp-cat", name: "Imported Category", emoji: "📦", color: "#8b5cf6" }
        ]
      };
      log("Sending importData...");
      const res = await chrome.runtime.sendMessage({ action: "importData", data: importData });
      log(`Import result: success=${res.success}, tabs=${res.tabsCount}, cats=${res.categoriesCount}`);
      if (!res.success) throw new Error("importData failed: " + res.error);
      if (res.tabsCount !== 2) throw new Error(`Expected 2 tabs, got ${res.tabsCount}`);
      if (res.categoriesCount !== 1) throw new Error(`Expected 1 category, got ${res.categoriesCount}`);

      const stored = await chrome.storage.local.get(["savedTabs", "categories"]);
      if (stored.savedTabs.length !== 2) throw new Error(`Storage has ${stored.savedTabs.length} tabs, expected 2`);
      if (stored.categories.length !== 1) throw new Error(`Storage has ${stored.categories.length} categories, expected 1`);
      if (stored.savedTabs[0].id !== importData.savedTabs[0].id) throw new Error("Tab data mismatch");

      for (const tab of stored.savedTabs) {
        if (tab.activeTabId !== null) throw new Error("Imported tab has non-null activeTabId");
        if (tab.status !== "cold") throw new Error("Imported tab status is not cold: " + tab.status);
      }
      log("All imported tabs are cold with null activeTabId");

      await chrome.storage.local.set({ savedTabs: [], categories: [] });
      return true;
    }
  },
  {
    id: "import-data-invalid",
    name: "Import Invalid Data Throws Error",
    desc: "Verifies importData rejects data without savedTabs or categories arrays",
    fn: async (log) => {
      try {
        await chrome.runtime.sendMessage({ action: "importData", data: { savedTabs: "not-an-array" } });
        throw new Error("Should have rejected invalid data");
      } catch (e) {
        if (e.message.includes("Invalid import data format")) {
          log("Correctly rejected: " + e.message);
          return true;
        }
        throw e;
      }
    }
  },
  {
    id: "import-data-sanitizes-hot-tabs",
    name: "Import Data Sanitizes Active/Hot Tabs to Cold",
    desc: "Verifies that imported tabs with active/hot status are forced to cold",
    fn: async (log) => {
      const now = Date.now();
      const importData = {
        savedTabs: [
          { id: "hot_import_" + now, categoryId: null, url: TEST_URL_A, title: "Was Hot", favIconUrl: "", status: "hot", activeTabId: 999, savedAt: now }
        ],
        categories: []
      };
      const res = await chrome.runtime.sendMessage({ action: "importData", data: importData });
      if (!res.success) throw new Error("importData failed: " + res.error);

      const stored = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const tab = stored.find(t => t.id === importData.savedTabs[0].id);
      if (tab.status !== "cold") throw new Error(`Status is "${tab.status}", expected "cold"`);
      if (tab.activeTabId !== null) throw new Error("activeTabId is not null");
      log("Imported hot tab sanitized to cold with null activeTabId");

      await chrome.storage.local.set({ savedTabs: [], categories: [] });
      return true;
    }
  },
  {
    id: "save-duplicate-url-different-tab",
    name: "Saving Same URL for Different Tab Creates Separate Entry",
    desc: "Verifies that saving a URL already saved under a different tabId creates a new entry",
    fn: async (log) => {
      const tabA = await chrome.tabs.create({ url: TEST_URL_A, active: false });
      const saveRes = await chrome.runtime.sendMessage({ action: "saveActiveTab", tabId: tabA.id, categoryId: null });
      const firstId = saveRes.tab.id;
      log(`Saved first tab: ${firstId}, url: ${saveRes.tab.url}`);

      const tabB = await chrome.tabs.create({ url: TEST_URL_A, active: false });
      const saveResB = await chrome.runtime.sendMessage({ action: "saveActiveTab", tabId: tabB.id, categoryId: null });
      const secondId = saveResB.tab.id;
      log(`Saved second tab (same URL): ${secondId}, url: ${saveResB.tab.url}`);

      if (firstId === secondId) throw new Error("Duplicate URL save returned same tab ID");
      if (saveResB.tab.url !== saveRes.tab.url) throw new Error("URLs don't match");

      const savedTabs = (await chrome.storage.local.get("savedTabs")).savedTabs || [];
      const entries = savedTabs.filter(t => t.url === TEST_URL_A);
      log(`Entries for this URL: ${entries.length}`);

      if (entries.length < 2) throw new Error(`Expected at least 2 entries, got ${entries.length}`);

      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId: firstId });
      await chrome.runtime.sendMessage({ action: "removeSavedTab", savedTabId: secondId });
      await chrome.tabs.remove(tabA.id);
      await chrome.tabs.remove(tabB.id);
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
