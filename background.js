// Tabbies - Background Service Worker
// Manages the background window, tab state transitions, and chrome extension events.

let creatingWindowPromise = null;

// Helper to get or create the background storage window
async function getOrCreateStorageWindow() {
  if (creatingWindowPromise) {
    return creatingWindowPromise;
  }

  creatingWindowPromise = (async () => {
    const data = await chrome.storage.local.get("storageWindowId");
    let windowId = data.storageWindowId;

    if (windowId) {
      try {
        // Verify window still exists
        await chrome.windows.get(windowId);
        return windowId;
      } catch (e) {
        // Window doesn't exist anymore, reset it
        await chrome.storage.local.set({ storageWindowId: null });
        windowId = null;
      }
    }

    // Create the background storage window
    const anchorUrl = chrome.runtime.getURL("anchor.html");
    const win = await chrome.windows.create({
      url: anchorUrl,
      focused: false,
      type: "normal"
    });

    // Minimize the window immediately to keep it in the background
    await chrome.windows.update(win.id, { state: "minimized" });
    await chrome.storage.local.set({ storageWindowId: win.id });

    return win.id;
  })();

  try {
    const winId = await creatingWindowPromise;
    return winId;
  } finally {
    creatingWindowPromise = null;
  }
}

// Helper to get saved tabs from local storage
async function getSavedTabs() {
  const data = await chrome.storage.local.get("savedTabs");
  return data.savedTabs || [];
}

// === Category Management ===

async function getCategories() {
  const data = await chrome.storage.local.get("categories");
  return data.categories || [];
}

async function setCategories(categories) {
  await chrome.storage.local.set({ categories });
}

// Helper to save tabs list to local storage
async function setSavedTabs(savedTabs) {
  await chrome.storage.local.set({ savedTabs });
}

// Handle message commands from the popup UI or tests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(error => {
      console.error("Error handling message:", error);
      sendResponse({ success: false, error: error.message });
    });
  return true; // Keep channel open for asynchronous sendResponse
});

async function handleMessage(message, sender) {
  const savedTabs = await getSavedTabs();

  switch (message.action) {
    case "saveActiveTab": {
      const { tabId, categoryId } = message;
      const tab = await chrome.tabs.get(tabId);
      
      let existingIndex = savedTabs.findIndex(t => t.activeTabId === tabId);
      if (existingIndex === -1) {
        existingIndex = savedTabs.findIndex(t => t.status === "cold" && t.url === tab.url);
      }
      const now = Date.now();
      
      const tabData = {
        id: existingIndex >= 0 ? savedTabs[existingIndex].id : "tab_" + now + "_" + Math.random().toString(36).substr(2, 5),
        categoryId,
        url: tab.url,
        title: tab.title || "Untitled Tab",
        favIconUrl: tab.favIconUrl || "",
        status: "active",
        activeTabId: tabId,
        savedAt: existingIndex >= 0 ? savedTabs[existingIndex].savedAt : now
      };

      if (existingIndex >= 0) {
        savedTabs[existingIndex] = tabData;
      } else {
        savedTabs.push(tabData);
      }
      
      await setSavedTabs(savedTabs);
      return { success: true, tab: tabData };
    }

    case "shelveActiveTab": {
      const { tabId, categoryId } = message;
      const tab = await chrome.tabs.get(tabId);
      
      const storageWindowId = await getOrCreateStorageWindow();
      
      // Move the tab to the storage window
      await chrome.tabs.move(tabId, { windowId: storageWindowId, index: -1 });
      
      let existingIndex = savedTabs.findIndex(t => t.activeTabId === tabId);
      if (existingIndex === -1) {
        existingIndex = savedTabs.findIndex(t => t.status === "cold" && t.url === tab.url);
      }
      const now = Date.now();
      
      const tabData = {
        id: existingIndex >= 0 ? savedTabs[existingIndex].id : "tab_" + now + "_" + Math.random().toString(36).substr(2, 5),
        categoryId,
        url: tab.url,
        title: tab.title || "Untitled Tab",
        favIconUrl: tab.favIconUrl || "",
        status: "hot",
        activeTabId: tabId,
        savedAt: existingIndex >= 0 ? savedTabs[existingIndex].savedAt : now
      };

      if (existingIndex >= 0) {
        savedTabs[existingIndex] = tabData;
      } else {
        savedTabs.push(tabData);
      }

      await setSavedTabs(savedTabs);
      return { success: true, tab: tabData };
    }

    case "shelveSavedTab": {
      const { savedTabId } = message;
      const tabIndex = savedTabs.findIndex(t => t.id === savedTabId);
      if (tabIndex === -1) throw new Error("Saved tab not found");
      
      const tab = savedTabs[tabIndex];
      if (tab.status !== "active") throw new Error("Tab is not active");

      const storageWindowId = await getOrCreateStorageWindow();
      
      // Move to background storage window
      await chrome.tabs.move(tab.activeTabId, { windowId: storageWindowId, index: -1 });
      
      tab.status = "hot";
      savedTabs[tabIndex] = tab;
      
      await setSavedTabs(savedTabs);
      return { success: true, tab };
    }

    case "unshelveTab": {
      const { savedTabId } = message;
      const tabIndex = savedTabs.findIndex(t => t.id === savedTabId);
      if (tabIndex === -1) throw new Error("Saved tab not found");
      
      const tab = savedTabs[tabIndex];
      if (tab.status !== "hot") throw new Error("Tab is not shelved");

      const lastFocused = await chrome.windows.getLastFocused();
      const targetWindowId = lastFocused.id;

      // Move the tab back to the active window
      await chrome.tabs.move(tab.activeTabId, { windowId: targetWindowId, index: -1 });
      
      // Focus the tab and the window
      await chrome.tabs.update(tab.activeTabId, { active: true });
      await chrome.windows.update(targetWindowId, { focused: true });

      tab.status = "active";
      savedTabs[tabIndex] = tab;
      
      await setSavedTabs(savedTabs);
      return { success: true, tab };
    }

    case "openColdTab": {
      const { savedTabId } = message;
      const tabIndex = savedTabs.findIndex(t => t.id === savedTabId);
      if (tabIndex === -1) throw new Error("Saved tab not found");
      
      const tab = savedTabs[tabIndex];
      if (tab.status !== "cold") throw new Error("Tab is already open");

      const lastFocused = await chrome.windows.getLastFocused();
      const targetWindowId = lastFocused.id;

      // Create new tab with stored URL
      const newChromeTab = await chrome.tabs.create({
        windowId: targetWindowId,
        url: tab.url,
        active: true
      });
      
      await chrome.windows.update(targetWindowId, { focused: true });

      tab.status = "active";
      tab.activeTabId = newChromeTab.id;
      savedTabs[tabIndex] = tab;

      await setSavedTabs(savedTabs);
      return { success: true, tab };
    }

    case "focusActiveTab": {
      const { savedTabId } = message;
      const tab = savedTabs.find(t => t.id === savedTabId);
      if (!tab) throw new Error("Saved tab not found");
      if (tab.status !== "active") throw new Error("Tab is not active");

      // Get window info first to focus the window
      const chromeTab = await chrome.tabs.get(tab.activeTabId);
      await chrome.tabs.update(tab.activeTabId, { active: true });
      await chrome.windows.update(chromeTab.windowId, { focused: true });

      return { success: true };
    }

    case "removeSavedTab": {
      const { savedTabId } = message;
      const tabIndex = savedTabs.findIndex(t => t.id === savedTabId);
      if (tabIndex === -1) throw new Error("Saved tab not found");

      const tab = savedTabs[tabIndex];
      
      // If it is in hot storage, close it. If active, keep it open but untracked.
      if (tab.status === "hot") {
        try {
          await chrome.tabs.remove(tab.activeTabId);
        } catch (e) {
          // Tab might have already been closed
        }
      }

      // Remove from list
      savedTabs.splice(tabIndex, 1);
      await setSavedTabs(savedTabs);
      
      return { success: true };
    }

    case "getAllData": {
      const categories = await getCategories();
      return { success: true, data: { savedTabs, categories } };
    }

    case "createCategory": {
      const { name, emoji, color } = message;
      const cats = await getCategories();
      const newCat = {
        id: "cat_" + Date.now() + "_" + Math.random().toString(36).substr(2, 7),
        name,
        emoji: emoji || "📁",
        color: color || "#6b7280"
      };
      cats.push(newCat);
      await setCategories(cats);
      return { success: true, category: newCat };
    }

    case "updateCategory": {
      const { id, name, emoji, color } = message;
      const catsUpd = await getCategories();
      const catIdx = catsUpd.findIndex(c => c.id === id);
      if (catIdx === -1) throw new Error("Category not found");
      if (name !== undefined) catsUpd[catIdx].name = name;
      if (emoji !== undefined) catsUpd[catIdx].emoji = emoji;
      if (color !== undefined) catsUpd[catIdx].color = color;
      await setCategories(catsUpd);
      return { success: true, category: catsUpd[catIdx] };
    }

    case "deleteCategory": {
      const { id: catId } = message;
      let catsDel = await getCategories();
      catsDel = catsDel.filter(c => c.id !== catId);
      await setCategories(catsDel);
      return { success: true };
    }

    default:
      throw new Error("Unknown action: " + message.action);
  }
}

// Window removed handler: transitions hot tabs to cold if background window is closed
chrome.windows.onRemoved.addListener(async (windowId) => {
  const data = await chrome.storage.local.get("storageWindowId");
  const storageWindowId = data.storageWindowId;

  if (windowId === storageWindowId) {
    // Background window closed, reset storageWindowId and update hot tabs to cold
    await chrome.storage.local.set({ storageWindowId: null });
    
    const savedTabs = await getSavedTabs();
    let changed = false;
    
    const updatedTabs = savedTabs.map(tab => {
      if (tab.status === "hot") {
        changed = true;
        return { ...tab, status: "cold", activeTabId: null };
      }
      return tab;
    });

    if (changed) {
      await setSavedTabs(updatedTabs);
    }
  }
});

// Tab removed handler: transitions active/hot tabs to cold when closed by the user
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const data = await chrome.storage.local.get(["savedTabs", "storageWindowId"]);
  let savedTabs = data.savedTabs || [];
  const storageWindowId = data.storageWindowId;

  let changed = false;
  const updatedTabs = savedTabs.map(tab => {
    if ((tab.status === "active" || tab.status === "hot") && tab.activeTabId === tabId) {
      changed = true;
      return { ...tab, status: "cold", activeTabId: null };
    }
    return tab;
  });

  if (changed) {
    await setSavedTabs(updatedTabs);
  }

  // Self-healing: if the closed tab was inside the storage window, verify if we need to recreate the anchor tab
  if (storageWindowId && removeInfo.windowId === storageWindowId) {
    try {
      const tabs = await chrome.tabs.query({ windowId: storageWindowId });
      const hasAnchor = tabs.some(t => t.url && t.url.includes("anchor.html"));
      
      // If no anchor tab remains, recreate it at the beginning of the window
      if (!hasAnchor && tabs.length > 0) {
        await chrome.tabs.create({
          windowId: storageWindowId,
          url: chrome.runtime.getURL("anchor.html"),
          index: 0,
          active: false
        });
      }
    } catch (e) {
      // Storage window might be gone or closing
    }
  }
});

// Tab updated handler: synchronizes active tab changes (title, URL, favicon) with saved metadata
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    const savedTabs = await getSavedTabs();
    let changed = false;

    const updatedTabs = savedTabs.map(savedTab => {
      if (savedTab.status === "active" && savedTab.activeTabId === tabId) {
        const newUrl = tab.url;
        const newTitle = tab.title || savedTab.title;
        const newFavIcon = tab.favIconUrl || savedTab.favIconUrl;

        if (savedTab.url !== newUrl || savedTab.title !== newTitle || savedTab.favIconUrl !== newFavIcon) {
          changed = true;
          return {
            ...savedTab,
            url: newUrl,
            title: newTitle,
            favIconUrl: newFavIcon
          };
        }
      }
      return savedTab;
    });

    if (changed) {
      await setSavedTabs(updatedTabs);
    }
  }
});
