// Tabbies - Background Service Worker
// Manages the background window, tab state transitions, and chrome extension events.

let creatingWindowPromise = null;
let recreatingAnchor = false;

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

    const anchorUrl = chrome.runtime.getURL("anchor.html");
    const win = await chrome.windows.create({
      url: anchorUrl,
      focused: false,
      type: "normal"
    });

    await chrome.storage.local.set({ storageWindowId: win.id });
    await chrome.windows.update(win.id, { state: "minimized" });

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
  await updateBadge();
}

// Update the extension toolbar badge with the count of saved tabs
async function updateBadge() {
  const data = await chrome.storage.local.get("savedTabs");
  const count = (data.savedTabs || []).length;
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#4f46e5" });
}

// Listen for external storage changes to keep the badge in sync
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "savedTabs" in changes) {
    updateBadge();
  }
});

// Get a target normal window, excluding the storage window
async function getTargetWindow() {
  const storageData = await chrome.storage.local.get("storageWindowId");
  const storageWindowId = storageData.storageWindowId;
  const lastFocused = await chrome.windows.getLastFocused();
  if (lastFocused.id !== storageWindowId) return lastFocused.id;
  const windows = await chrome.windows.getAll();
  const target = windows.find(w => w.id !== storageWindowId);
  return target ? target.id : lastFocused.id;
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

      const targetWindowId = await getTargetWindow();

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

      const targetWindowId = await getTargetWindow();

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

    case "openAllColdTabs": {
      const { categoryId } = message;
      const coldTabs = savedTabs.filter(t => t.categoryId === categoryId && t.status === "cold");
      if (coldTabs.length === 0) return { success: true, opened: [] };
      const targetWindowId = await getTargetWindow();
      const opened = [];
      for (const tab of coldTabs) {
        const newChromeTab = await chrome.tabs.create({
          windowId: targetWindowId,
          url: tab.url,
          active: false
        });
        tab.status = "active";
        tab.activeTabId = newChromeTab.id;
        opened.push(tab);
      }
      await setSavedTabs(savedTabs);
      return { success: true, opened };
    }

    case "moveTab": {
      const { savedTabId, newCategoryId, targetIndex } = message;
      const tabIndex = savedTabs.findIndex(t => t.id === savedTabId);
      if (tabIndex === -1) throw new Error("Saved tab not found");
      const [tab] = savedTabs.splice(tabIndex, 1);
      if (newCategoryId !== undefined) {
        tab.categoryId = newCategoryId;
      }
      let insertAt = targetIndex ?? savedTabs.length;
      if (tabIndex < insertAt) insertAt = Math.max(0, insertAt - 1);
      insertAt = Math.min(insertAt, savedTabs.length);
      savedTabs.splice(insertAt, 0, tab);
      tab.savedAt = Date.now();
      await setSavedTabs(savedTabs);
      return { success: true, tab };
    }

    case "reorderCategories": {
      const { orderedIds } = message;
      const cats = await getCategories();
      const reordered = orderedIds.map(id => cats.find(c => c.id === id)).filter(Boolean);
      const remaining = cats.filter(c => !orderedIds.includes(c.id));
      await setCategories([...reordered, ...remaining]);
      rebuildContextMenus();
      return { success: true };
    }

    case "saveAllTabs": {
      const { windowId, categoryId } = message;
      const tabs = await chrome.tabs.query({ windowId });
      const saved = [];
      for (const tab of tabs) {
        if (tab.url && (tab.url.startsWith("chrome://") || tab.url.startsWith("about:") || tab.url.startsWith("devtools://") || tab.url.startsWith("edge://"))) {
          continue;
        }
        let existingIndex = savedTabs.findIndex(t => t.activeTabId === tab.id);
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
          activeTabId: tab.id,
          savedAt: existingIndex >= 0 ? savedTabs[existingIndex].savedAt : now
        };
        if (existingIndex >= 0) {
          savedTabs[existingIndex] = tabData;
        } else {
          savedTabs.push(tabData);
        }
        saved.push(tabData);
      }
      await setSavedTabs(savedTabs);
      return { success: true, saved, count: saved.length };
    }

    case "archiveCategory": {
      const { categoryId } = message;
      let changed = false;
      let archivedCount = 0;
      for (const tab of savedTabs) {
        if (tab.categoryId === categoryId && (tab.status === "active" || tab.status === "hot")) {
          if (tab.activeTabId) {
            try { await chrome.tabs.remove(tab.activeTabId); } catch (e) {}
          }
          tab.status = "cold";
          tab.activeTabId = null;
          changed = true;
          archivedCount++;
        }
      }
      if (changed) {
        await setSavedTabs(savedTabs);
      }
      return { success: true, archived: archivedCount };
    }

    case "importData": {
      const { data } = message;
      if (!data || !Array.isArray(data.savedTabs) || !Array.isArray(data.categories)) {
        throw new Error("Invalid import data format: expected savedTabs and categories arrays");
      }
      const sanitized = data.savedTabs.map(t => ({ ...t, status: "cold", activeTabId: null }));
      await chrome.storage.local.set({ savedTabs: sanitized, categories: data.categories });
      await updateBadge();
      rebuildContextMenus();
      return { success: true, tabsCount: sanitized.length, categoriesCount: data.categories.length };
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
      savedTabs.splice(tabIndex, 1);
      await setSavedTabs(savedTabs);

      if (tab.status === "hot") {
        try {
          await chrome.tabs.remove(tab.activeTabId);
        } catch (e) {
          // Tab may have already been closed
        }
      }

      return { success: true };
    }

    case "updateSavedTab": {
      const { savedTabId, updates } = message;
      const tabIndex = savedTabs.findIndex(t => t.id === savedTabId);
      if (tabIndex === -1) throw new Error("Saved tab not found");
      if (typeof updates !== "object" || updates === null) throw new Error("Invalid updates payload");
      const allowed = ["categoryId", "title", "url", "favIconUrl"];
      for (const key of Object.keys(updates)) {
        if (!allowed.includes(key)) {
          throw new Error("Cannot update field: " + key);
        }
      }
      Object.assign(savedTabs[tabIndex], updates);
      savedTabs[tabIndex].savedAt = Date.now();
      await setSavedTabs(savedTabs);
      return { success: true, tab: savedTabs[tabIndex] };
    }

    case "clearAllTabs": {
      for (const tab of savedTabs) {
        if (tab.status === "hot" && tab.activeTabId) {
          try { await chrome.tabs.remove(tab.activeTabId); } catch (e) {}
        }
      }
      const removed = savedTabs.length;
      await chrome.storage.local.set({ savedTabs: [] });
      await updateBadge();
      return { success: true, removed };
    }

    case "restoreSavedTabs": {
      const { savedTabs: restoredTabs, categories: restoredCategories } = message;
      if (restoredTabs && Array.isArray(restoredTabs)) {
        await chrome.storage.local.set({ savedTabs: restoredTabs });
      }
      if (restoredCategories && Array.isArray(restoredCategories)) {
        await chrome.storage.local.set({ categories: restoredCategories });
      }
      await updateBadge();
      rebuildContextMenus();
      return { success: true, restored: (restoredTabs || []).length };
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
      rebuildContextMenus();
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
      rebuildContextMenus();
      return { success: true, category: catsUpd[catIdx] };
    }

    case "duplicateCategory": {
      const { id: catId } = message;
      const cats = await getCategories();
      const source = cats.find(c => c.id === catId);
      if (!source) throw new Error("Category not found");
      const newCat = {
        id: "cat_" + Date.now() + "_" + Math.random().toString(36).substr(2, 7),
        name: source.name + " (copy)",
        emoji: source.emoji || "📁",
        color: source.color
      };
      cats.push(newCat);
      await setCategories(cats);
      const dupTabs = savedTabs.filter(t => t.categoryId === catId).map(t => ({
        ...t,
        id: "tab_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
        categoryId: newCat.id,
        savedAt: Date.now()
      }));
      if (dupTabs.length > 0) {
        savedTabs.push(...dupTabs);
        await setSavedTabs(savedTabs);
      }
      rebuildContextMenus();
      return { success: true, category: newCat, tabsCopied: dupTabs.length };
    }

    case "deleteCategory": {
      const { id: catId } = message;
      let catsDel = await getCategories();
      catsDel = catsDel.filter(c => c.id !== catId);
      await setCategories(catsDel);
      rebuildContextMenus();
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

  if (storageWindowId && removeInfo.windowId === storageWindowId && !recreatingAnchor) {
    recreatingAnchor = true;
    try {
      const tabs = await chrome.tabs.query({ windowId: storageWindowId });
      const hasAnchor = tabs.some(t => t.url && t.url.includes("anchor.html"));
      if (!hasAnchor && tabs.length > 0) {
        await chrome.tabs.create({
          windowId: storageWindowId,
          url: chrome.runtime.getURL("anchor.html"),
          index: 0,
          active: false
        });
      }
    } catch (e) {
      // Storage window may be gone or closing
    } finally {
      recreatingAnchor = false;
    }
  }
});

// Keyboard shortcut handler
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "_execute_action") return;
});

// Startup recovery: verify storage window and transition orphaned hot tabs to cold
async function recoverState() {
  const data = await chrome.storage.local.get(["storageWindowId", "savedTabs"]);
  const windowId = data.storageWindowId;
  let savedTabs = data.savedTabs || [];
  let changed = false;

  if (windowId) {
    try {
      await chrome.windows.get(windowId);
    } catch (e) {
      await chrome.storage.local.set({ storageWindowId: null });
      savedTabs = savedTabs.map(t => {
        if (t.status === "hot") {
          changed = true;
          return { ...t, status: "cold", activeTabId: null };
        }
        return t;
      });
    }
  } else {
    savedTabs = savedTabs.map(t => {
      if (t.status === "hot") {
        changed = true;
        return { ...t, status: "cold", activeTabId: null };
      }
      return t;
    });
  }

  if (changed) {
    await chrome.storage.local.set({ savedTabs });
  }
  await updateBadge();
}

chrome.runtime.onStartup.addListener(recoverState);
chrome.runtime.onInstalled.addListener(recoverState);

// === Context Menu ===

async function rebuildContextMenus() {
  await chrome.contextMenus.removeAll();
  const categories = await getCategories();

  chrome.contextMenus.create({
    id: "tabbies-root",
    title: "Tabbies",
    contexts: ["page"]
  });

  chrome.contextMenus.create({
    id: "tabbies-save",
    parentId: "tabbies-root",
    title: "Save Tab",
    contexts: ["page"]
  });

  chrome.contextMenus.create({
    id: "tabbies-shelve",
    parentId: "tabbies-root",
    title: "Shelve Tab",
    contexts: ["page"]
  });

  const addItems = (prefix, parentId) => {
    if (categories.length === 0) {
      chrome.contextMenus.create({
        id: `${prefix}__none`,
        parentId,
        title: "No category",
        contexts: ["page"]
      });
    } else {
      categories.forEach(cat => {
        chrome.contextMenus.create({
          id: `${prefix}${cat.id}`,
          parentId,
          title: `${cat.emoji || "📁"} ${cat.name}`,
          contexts: ["page"]
        });
      });
    }
  };

  addItems("tabbies-save-", "tabbies-save");
  addItems("tabbies-shelve-", "tabbies-shelve");
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = info.menuItemId;
  if (id.startsWith("tabbies-save-")) {
    const categoryId = id.replace("tabbies-save-", "");
    await handleMessage({ action: "saveActiveTab", tabId: tab.id, categoryId: categoryId === "__none" ? null : categoryId }, { tab });
  } else if (id.startsWith("tabbies-shelve-")) {
    const categoryId = id.replace("tabbies-shelve-", "");
    await handleMessage({ action: "shelveActiveTab", tabId: tab.id, categoryId: categoryId === "__none" ? null : categoryId }, { tab });
  }
});

chrome.runtime.onStartup.addListener(() => rebuildContextMenus());
chrome.runtime.onInstalled.addListener(() => rebuildContextMenus());

// === Omnibox Search ===

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  if (!text.trim()) {
    suggest([]);
    return;
  }
  const q = text.toLowerCase();
  getSavedTabs().then(savedTabs => {
    const matches = savedTabs.filter(t =>
      (t.title && t.title.toLowerCase().includes(q)) ||
      (t.url && t.url.toLowerCase().includes(q))
    ).slice(0, 5);
    suggest(matches.map(t => ({
      content: t.id,
      description: `${t.title || "Untitled"} — ${t.url} [${t.status}]`
    })));
  });
});

chrome.omnibox.onInputEntered.addListener(async (content, disposition) => {
  const savedTabs = await getSavedTabs();
  const tab = savedTabs.find(t => t.id === content);
  if (!tab) return;
  try {
    if (tab.status === "active") {
      await handleMessage({ action: "focusActiveTab", savedTabId: content }, {});
    } else if (tab.status === "hot") {
      await handleMessage({ action: "unshelveTab", savedTabId: content }, {});
    } else if (tab.status === "cold") {
      await handleMessage({ action: "openColdTab", savedTabId: content }, {});
    }
  } catch (e) {
    console.error("Omnibox action failed:", e);
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
