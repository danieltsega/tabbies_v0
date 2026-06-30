const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280"];
const CAT_ICONS = ["📁", "💼", "🏠", "⭐", "❤️", "🎯", "📚", "🎮", "🎵", "✈️", "💡", "🛒"];

const FAV_FALLBACK = (() => {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">',
    '<rect width="16" height="16" rx="2" fill="rgba(79,70,229,0.06)"/>',
    '<circle cx="8" cy="8" r="3" fill="#94a3b8" opacity="0.25"/>',
    '</svg>'
  ].join("");
  return 'data:image/svg+xml;base64,' + btoa(svg);
})();

let state = { savedTabs: [], categories: [], activeTab: null, saveCategoryId: null, searchQuery: "", statusFilter: "all", collapsed: {}, sortBy: "newest" };
let editingCategoryId = null;
let pendingUndo = null;
let undoTimeout = null;

function pushUndo(savedTabs, categories, message) {
  if (undoTimeout) clearTimeout(undoTimeout);
  pendingUndo = { savedTabs: JSON.parse(JSON.stringify(savedTabs)), categories: JSON.parse(JSON.stringify(categories)), message };
  showUndoToast(message);
}

function clearUndo() {
  if (undoTimeout) clearTimeout(undoTimeout);
  pendingUndo = null;
  $("undo-toast")?.classList.add("hidden");
}

function showUndoToast(msg) {
  $("undo-message").textContent = msg;
  $("undo-toast").classList.remove("hidden");
  undoTimeout = setTimeout(clearUndo, 5000);
}

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  initColorPicker();
  await loadData();
  render();
  bindEvents();
});

async function loadData() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.activeTab = tab ? { id: tab.id, url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl, windowId: tab.windowId } : null;
  try {
    const res = await chrome.runtime.sendMessage({ action: "getAllData" });
    if (res.success) {
      state.savedTabs = res.data.savedTabs;
      state.categories = res.data.categories;
      if (state.categories.length > 0 && !state.saveCategoryId) {
        state.saveCategoryId = state.categories[0].id;
      }
    }
  } catch (e) {
    console.error("Failed to load data:", e);
  }
  try {
    const { collapsed } = await chrome.storage.local.get("collapsed");
    if (collapsed) state.collapsed = collapsed;
  } catch (e) {}
}

function renderActionBar() {
  const sel = $("save-category-select");
  if (!sel) return;
  if (state.categories.length === 0) {
    sel.style.display = "none";
    return;
  }
  sel.style.display = "";
  const currentVal = state.saveCategoryId;
  sel.innerHTML = `
    <option value="">No category</option>
    ${state.categories.map(c =>
      `<option value="${escapeHtml(c.id)}" ${c.id === currentVal ? "selected" : ""}>${escapeHtml(c.emoji || "📁")} ${escapeHtml(c.name)}</option>`
    ).join("")}
  `;
}

function getFilteredTabs() {
  let tabs = state.savedTabs;
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    tabs = tabs.filter(t =>
      (t.title && t.title.toLowerCase().includes(q)) ||
      (t.url && t.url.toLowerCase().includes(q))
    );
  }
  if (state.statusFilter !== "all") {
    tabs = tabs.filter(t => t.status === state.statusFilter);
  }
  return tabs;
}

function getSortedTabs(tabs) {
  const sorted = [...tabs];
  sorted.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    switch (state.sortBy) {
      case "oldest": return (a.savedAt || 0) - (b.savedAt || 0);
      case "title-asc": return (a.title || "").localeCompare(b.title || "");
      case "title-desc": return (b.title || "").localeCompare(a.title || "");
      default: return (b.savedAt || 0) - (a.savedAt || 0); // newest
    }
  });
  return sorted;
}

function renderFilterBar() {
  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.filter === state.statusFilter);
  });
}

function renderSortBar() {
  const sel = $("sort-select");
  if (sel) sel.value = state.sortBy;
}

function render() {
  renderActionBar();
  renderFilterBar();
  renderSortBar();
  const container = $("tab-list");
  container.innerHTML = "";
  const visibleTabs = getSortedTabs(getFilteredTabs());

  const footer = $("footer");
  if (footer) {
    footer.style.display = state.savedTabs.length > 0 ? "" : "none";
  }

  const clearVisibleBtn = $("clear-visible-btn");
  if (clearVisibleBtn) {
    const isFiltered = state.searchQuery || state.statusFilter !== "all";
    const hasLess = visibleTabs.length < state.savedTabs.length;
    clearVisibleBtn.style.display = isFiltered && hasLess && visibleTabs.length > 0 ? "" : "none";
    clearVisibleBtn.textContent = `Remove visible (${visibleTabs.length})`;
  }

  if (visibleTabs.length === 0) {
    container.innerHTML = state.searchQuery
      ? `<div class="empty-state">No tabs matching "${escapeHtml(state.searchQuery)}"</div>`
      : `<div class="empty-state">No saved tabs yet.<br>Use the buttons above to save or shelve your current tab.</div>`;
    return;
  }
  const catIds = new Set(state.categories.map((c) => c.id));
  state.categories.forEach((cat) => {
    const tabs = visibleTabs.filter((t) => t.categoryId === cat.id);
    if (tabs.length > 0) {
      container.appendChild(renderCategory(cat, tabs));
    }
  });
  const uncategorized = visibleTabs.filter((t) => !catIds.has(t.categoryId));
  if (uncategorized.length > 0) {
    container.appendChild(
      renderCategory({ id: "__uncategorized", name: "Uncategorized", emoji: "📂", color: "#6b7280" }, uncategorized)
    );
  }
}

function renderCategory(category, tabs) {
  const div = document.createElement("div");
  div.className = "category";
  const isBuiltIn = category.id === "__uncategorized";
  const coldCount = tabs.filter(t => t.status === "cold").length;
  const hotCount = tabs.filter(t => t.status === "hot").length;
  const activeCount = tabs.filter(t => t.status === "active").length;
  const openCount = activeCount + hotCount;
  const isCollapsed = state.collapsed[category.id];
  const breakdown = [];
  if (activeCount > 0) breakdown.push(`<span class="cb cb-active">${activeCount}</span>`);
  if (hotCount > 0) breakdown.push(`<span class="cb cb-hot">${hotCount}</span>`);
  if (coldCount > 0) breakdown.push(`<span class="cb cb-cold">${coldCount}</span>`);
  div.innerHTML = `
    <div class="category-header" draggable="${isBuiltIn ? "false" : "true"}" data-category-id="${category.id}" style="--cat-color: ${category.color}">
      <span class="cat-chevron">${isCollapsed ? "▶" : "▼"}</span>
      <span class="cat-emoji">${category.emoji || "📁"}</span>
      <span class="cat-name">${escapeHtml(category.name)}</span>
      <span class="cat-count">${tabs.length}${breakdown.length > 0 ? ` ${breakdown.join("")}` : ""}</span>
      ${coldCount > 0 ? `<button class="cat-btn cat-open-all" data-id="${category.id}" title="Open all cold tabs (${coldCount})">▶ ${coldCount}</button>` : ""}
      ${openCount > 0 ? `<button class="cat-btn cat-archive" data-id="${category.id}" title="Archive all open tabs (${openCount})">❄</button>` : ""}
      ${isBuiltIn ? "" : `
        <button class="cat-btn cat-export" data-id="${category.id}" title="Export Category">↓</button>
        <button class="cat-btn cat-dup" data-id="${category.id}" title="Duplicate Category">⧉</button>
        <button class="cat-btn cat-edit" data-id="${category.id}" title="Edit Category">✎</button>
        <button class="cat-btn cat-delete" data-id="${category.id}" title="Delete Category">✕</button>
      `}
    </div>
    <div class="tab-list${isCollapsed ? " collapsed" : ""}" data-category-id="${category.id}">${tabs.map((t) => renderTabItem(t)).join("")}</div>
  `;
  return div;
}

function renderTabItem(tab) {
  const actions = getActions(tab);
  const statusLabels = { active: "Active", hot: "Shelved", cold: "Cold" };
  const src = tab.favIconUrl ? escapeHtml(tab.favIconUrl) : FAV_FALLBACK;
  const onerrorAttr = tab.favIconUrl ? ` onerror="this.onerror=null;this.src='${FAV_FALLBACK}'"` : "";
  const isRecent = tab.savedAt && Date.now() - tab.savedAt < 300000;

  const catOptions = state.categories.map(c =>
    `<button class="hm-item" data-action="setCategory" data-cat-id="${escapeHtml(c.id)}" data-id="${escapeHtml(tab.id)}"><span class="hm-color" style="background:${c.color}"></span>${escapeHtml(c.emoji || "📁")} ${escapeHtml(c.name)}${c.id === tab.categoryId ? ' ✓' : ''}</button>`
  ).join("");
  const hasMatchingCat = tab.categoryId && state.categories.some(c => c.id === tab.categoryId);
  const catSection = state.categories.length > 0 ? `
    <hr class="hm-divider">
    <div class="hm-label">Move to category</div>
    <button class="hm-item${!hasMatchingCat ? ' hm-active' : ''}" data-action="setCategory" data-cat-id="" data-id="${escapeHtml(tab.id)}">No category${!hasMatchingCat ? ' ✓' : ''}</button>
    ${catOptions}
  ` : "";

  return `
    <div class="tab-item${isRecent ? " tab-recent" : ""}${tab.pinned ? " tab-pinned" : ""}" draggable="true" data-id="${escapeHtml(tab.id)}" data-category="${escapeHtml(tab.categoryId || "")}">
      ${isRecent ? '<span class="recent-badge">NEW</span>' : ""}
      <img class="favicon" src="${src}"${onerrorAttr} />
      <span class="tab-title" title="${escapeHtml(tab.title)}&#10;${escapeHtml(tab.url)}">${escapeHtml(tab.title)}</span>
      <span class="tab-domain">${extractDomain(tab.url)}</span>
      <span class="tab-time">${relativeTime(tab.savedAt)}</span>
      <span class="status-dot status-${tab.status}" title="${statusLabels[tab.status] || tab.status}"></span>
      <div class="tab-actions">
        ${actions.map((a) => {
          const title = a.action === "removeSavedTab" ? "Remove" : a.label;
          return `<button class="act-btn act-${a.action}" data-action="${a.action}" data-id="${escapeHtml(tab.id)}" title="${escapeHtml(title)}">${a.label}</button>`;
        }).join("")}
      </div>
      <div class="tab-menu">
        <button class="hamburger" data-id="${escapeHtml(tab.id)}" title="More actions">⋮</button>
        <div class="hm-dropdown">
          <button class="hm-item" data-action="copyTabUrl" data-id="${escapeHtml(tab.id)}" data-url="${escapeHtml(tab.url)}">📋 Copy URL</button>
          <button class="hm-item" data-action="togglePin" data-id="${escapeHtml(tab.id)}">${tab.pinned ? '★' : '☆'} ${tab.pinned ? 'Unpin' : 'Pin to top'}</button>
          <button class="hm-item" data-action="moveTabToTop" data-id="${escapeHtml(tab.id)}">⬆ Move to top</button>
          <button class="hm-item" data-action="moveTabToBottom" data-id="${escapeHtml(tab.id)}">⬇ Move to bottom</button>
          ${catSection}
        </div>
      </div>
    </div>
  `;
}

function getActions(tab) {
  switch (tab.status) {
    case "active":
      return [
        { action: "focusActiveTab", label: "Focus" },
        { action: "shelveSavedTab", label: "Shelve" },
        { action: "removeSavedTab", label: "🗑" },
      ];
    case "hot":
      return [
        { action: "unshelveTab", label: "Unshelve" },
        { action: "removeSavedTab", label: "🗑" },
      ];
    case "cold":
      return [
        { action: "openColdTab", label: "Open" },
        { action: "removeSavedTab", label: "🗑" },
      ];
    default:
      return [{ action: "removeSavedTab", label: "🗑" }];
  }
}

let dragState = null;

function dropIndexFromMouse(catList, mouseY) {
  const items = [...catList.querySelectorAll(".tab-item")];
  for (let i = 0; i < items.length; i++) {
    const r = items[i].getBoundingClientRect();
    if (mouseY < r.top + r.height / 2) return i;
  }
  return items.length;
}

function categoryDropIndexFromMouse(mouseY) {
  const headers = [...document.querySelectorAll(".category > .category-header[data-category-id]")];
  for (let i = 0; i < headers.length; i++) {
    const r = headers[i].getBoundingClientRect();
    if (mouseY < r.top + r.height / 2) return i;
  }
  return headers.length;
}

function globalTabIndex(categoryId, localIndex) {
  let count = 0;
  for (let i = 0; i < state.savedTabs.length; i++) {
    const c = state.savedTabs[i].categoryId || null;
    if (c === (categoryId || null)) {
      if (count === localIndex) return i;
      count++;
    }
  }
  return state.savedTabs.length;
}

function setupDragDrop() {
  const list = $("tab-list");

  list.addEventListener("dragstart", (e) => {
    const item = e.target.closest(".tab-item");
    if (item) {
      dragState = { type: "tab", savedTabId: item.dataset.id, sourceCategoryId: item.dataset.category };
      e.dataTransfer.effectAllowed = "move";
      item.classList.add("dragging");
      return;
    }
    const cat = e.target.closest(".category-header[data-category-id]");
    if (cat && cat.draggable !== false) {
      dragState = { type: "category", categoryId: cat.dataset.categoryId };
      e.dataTransfer.effectAllowed = "move";
      cat.classList.add("dragging");
    }
  });

  list.addEventListener("dragend", () => {
    document.querySelectorAll(".dragging, .drag-over").forEach(el => el.classList.remove("dragging", "drag-over"));
    dragState = null;
  });

  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });

  list.addEventListener("dragenter", (e) => {
    const target = e.target.closest(".tab-list[data-category-id], #tab-list");
    if (target) target.classList.add("drag-over");
  });

  list.addEventListener("dragleave", (e) => {
    const target = e.target.closest(".tab-list[data-category-id], #tab-list");
    if (target && !target.contains(e.relatedTarget)) {
      target.classList.remove("drag-over");
    }
  });

  list.addEventListener("drop", (e) => {
    e.preventDefault();
    document.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
    if (!dragState) return;

    if (dragState.type === "tab") {
      const catList = e.target.closest(".tab-list[data-category-id]");
      if (!catList) return;
      const targetCategoryId = catList.dataset.categoryId;
      const localIdx = dropIndexFromMouse(catList, e.clientY);
      const globalIdx = globalTabIndex(targetCategoryId, localIdx);
      chrome.runtime.sendMessage({
        action: "moveTab",
        savedTabId: dragState.savedTabId,
        newCategoryId: targetCategoryId || null,
        targetIndex: globalIdx
      }).then(() => loadData().then(render)).catch(err => console.error("Move failed:", err));
      dragState = null;
      return;
    }

    if (dragState.type === "category") {
      const container = e.target.closest("#tab-list");
      if (!container) return;
      const localIdx = categoryDropIndexFromMouse(e.clientY);
      const ids = [...document.querySelectorAll(".category > .category-header[data-category-id]")].map(h => h.dataset.categoryId);
      const withMoved = ids.filter(id => id !== dragState.categoryId);
      withMoved.splice(Math.min(localIdx, withMoved.length), 0, dragState.categoryId);
      chrome.runtime.sendMessage({ action: "reorderCategories", orderedIds: withMoved })
        .then(() => loadData().then(render))
        .catch(err => console.error("Reorder failed:", err));
      dragState = null;
    }
  });
}

function bindEvents() {
  setupDragDrop();

  $("tab-list").addEventListener("change", async (e) => {
    const sel = e.target.closest(".cat-select");
    if (!sel) return;
    const savedTabId = sel.dataset.id;
    const newCategoryId = sel.value || null;
    try {
      await chrome.runtime.sendMessage({ action: "updateSavedTab", savedTabId, updates: { categoryId: newCategoryId } });
      await loadData();
      render();
    } catch (err) {
      console.error("Category move failed:", err);
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".hm-dropdown") && !e.target.closest(".hamburger")) {
      document.querySelectorAll(".tab-menu.open").forEach(m => m.classList.remove("open"));
    }
  });

  $("tab-list").addEventListener("click", async (e) => {
    const ham = e.target.closest(".hamburger");
    if (ham) {
      e.stopPropagation();
      const menu = ham.parentElement;
      const wasOpen = menu.classList.contains("open");
      document.querySelectorAll(".tab-menu.open").forEach(m => m.classList.remove("open"));
      if (!wasOpen) menu.classList.add("open");
      return;
    }

    const hmItem = e.target.closest(".hm-item");
    if (hmItem) {
      e.stopPropagation();
      const action = hmItem.dataset.action;
      const savedTabId = hmItem.dataset.id;
      hmItem.closest(".tab-menu")?.classList.remove("open");
      if (action === "setCategory") {
        const newCategoryId = hmItem.dataset.catId || null;
        try {
          await chrome.runtime.sendMessage({ action: "updateSavedTab", savedTabId, updates: { categoryId: newCategoryId } });
          await loadData();
          render();
        } catch (err) {
          console.error("Category move failed:", err);
        }
        return;
      }
      if (action === "copyTabUrl") {
        const url = hmItem.dataset.url;
        if (url) {
          try {
            await navigator.clipboard.writeText(url);
            hmItem.textContent = "✓ Copied!";
            setTimeout(() => { hmItem.textContent = "📋 Copy URL"; }, 1500);
          } catch (err) {
            console.error("Copy failed:", err);
          }
        }
        return;
      }
      if (action === "togglePin") {
        const tab = state.savedTabs.find(t => t.id === savedTabId);
        if (tab) {
          try {
            await chrome.runtime.sendMessage({ action: "updateSavedTab", savedTabId, updates: { pinned: !tab.pinned } });
            await loadData();
            render();
          } catch (err) {
            console.error("Pin toggle failed:", err);
          }
        }
        return;
      }
      if (action === "moveTabToTop" || action === "moveTabToBottom") {
        const tab = state.savedTabs.find(t => t.id === savedTabId);
        if (tab) {
          const catTabs = state.savedTabs.filter(t => (t.categoryId || null) === (tab.categoryId || null));
          if (catTabs.length > 1) {
            const isTop = action === "moveTabToTop";
            const targetTab = catTabs[isTop ? 0 : catTabs.length - 1];
            const targetGlobalIdx = state.savedTabs.indexOf(targetTab);
            const targetIdx = isTop ? targetGlobalIdx : targetGlobalIdx + 1;
            try {
              await chrome.runtime.sendMessage({ action: "moveTab", savedTabId, targetIndex: targetIdx });
              await loadData();
              render();
            } catch (err) {
              console.error("Move failed:", err);
            }
          }
        }
        return;
      }
      return;
    }

    const btn = e.target.closest(".act-btn");
    if (btn) {
      e.stopPropagation();
      const action = btn.dataset.action;
      const savedTabId = btn.dataset.id;
      if (action === "removeSavedTab" && !confirm("Remove this saved tab?")) return;
      if (action === "removeSavedTab") {
        pushUndo(state.savedTabs, state.categories, "Tab removed");
      }
      try {
        await chrome.runtime.sendMessage({ action, savedTabId });
        await loadData();
        render();
      } catch (err) {
        console.error("Action failed:", err);
      }
      return;
    }
    const openAllBtn = e.target.closest(".cat-open-all");
    if (openAllBtn) {
      const categoryId = openAllBtn.dataset.id;
      try {
        await chrome.runtime.sendMessage({ action: "openAllColdTabs", categoryId });
        await loadData();
        render();
      } catch (err) {
        console.error("Open all failed:", err);
      }
      return;
    }

    const archiveBtn = e.target.closest(".cat-archive");
    if (archiveBtn) {
      const categoryId = archiveBtn.dataset.id;
      if (!confirm(`Archive all open tabs in this category?`)) return;
      pushUndo(state.savedTabs, state.categories, "Tabs archived");
      try {
        await chrome.runtime.sendMessage({ action: "archiveCategory", categoryId });
        await loadData();
        render();
      } catch (err) {
        console.error("Archive failed:", err);
      }
      return;
    }

    const dupBtn = e.target.closest(".cat-dup");
    if (dupBtn) {
      try {
        await chrome.runtime.sendMessage({ action: "duplicateCategory", id: dupBtn.dataset.id });
        await loadData();
        render();
      } catch (err) {
        console.error("Duplicate category failed:", err);
      }
      return;
    }

    const exportBtn = e.target.closest(".cat-export");
    if (exportBtn) {
      try {
        const res = await chrome.runtime.sendMessage({ action: "exportCategory", id: exportBtn.dataset.id });
        const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `tabbies-${res.data.category.name.replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error("Export category failed:", err);
      }
      return;
    }

    const editBtn = e.target.closest(".cat-edit");
    if (editBtn) {
      openCategoryModal(editBtn.dataset.id);
      return;
    }
    const delBtn = e.target.closest(".cat-delete");
    if (delBtn) {
      if (confirm("Delete this category? Tabs in it will become uncategorized.")) {
        try {
          await chrome.runtime.sendMessage({ action: "deleteCategory", id: delBtn.dataset.id });
          await loadData();
          render();
        } catch (err) {
          console.error("Delete category failed:", err);
        }
      }
      return;
    }

    const catHeader = e.target.closest(".category-header");
    if (catHeader) {
      const catId = catHeader.dataset.categoryId;
      if (catId) {
        state.collapsed[catId] = !state.collapsed[catId];
        saveCollapsedState();
        render();
      }
    }
  });

  $("save-active-btn").addEventListener("click", async () => {
    if (!state.activeTab) return;
    try {
      const catId = state.saveCategoryId || null;
      await chrome.runtime.sendMessage({ action: "saveActiveTab", tabId: state.activeTab.id, categoryId: catId });
      await loadData();
      render();
    } catch (err) {
      console.error("Save failed:", err);
    }
  });

  $("shelve-active-btn").addEventListener("click", async () => {
    if (!state.activeTab) return;
    try {
      const catId = state.saveCategoryId || null;
      await chrome.runtime.sendMessage({ action: "shelveActiveTab", tabId: state.activeTab.id, categoryId: catId });
      await loadData();
      render();
    } catch (err) {
      console.error("Shelve failed:", err);
    }
  });

  $("save-all-btn").addEventListener("click", async () => {
    if (!state.activeTab) return;
    try {
      const catId = state.saveCategoryId || null;
      await chrome.runtime.sendMessage({ action: "saveAllTabs", windowId: state.activeTab.windowId, categoryId: catId });
      await loadData();
      render();
    } catch (err) {
      console.error("Save all failed:", err);
    }
  });

  $("clear-visible-btn").addEventListener("click", async () => {
    const visibleTabs = getSortedTabs(getFilteredTabs());
    if (visibleTabs.length === 0) return;
    if (!confirm(`Remove all ${visibleTabs.length} visible tabs?`)) return;
    pushUndo(state.savedTabs, state.categories, "Visible tabs removed");
    try {
      await chrome.runtime.sendMessage({ action: "removeMultipleTabs", savedTabIds: visibleTabs.map(t => t.id) });
      await loadData();
      render();
    } catch (err) {
      console.error("Remove visible failed:", err);
    }
  });

  $("clear-all-btn").addEventListener("click", async () => {
    if (state.savedTabs.length === 0) return;
    if (!confirm(`Remove all ${state.savedTabs.length} saved tabs?`)) return;
    pushUndo(state.savedTabs, state.categories, "All tabs removed");
    try {
      await chrome.runtime.sendMessage({ action: "clearAllTabs" });
      await loadData();
      render();
    } catch (err) {
      console.error("Clear all failed:", err);
    }
  });

  $("export-btn").addEventListener("click", async () => {
    try {
      const res = await chrome.runtime.sendMessage({ action: "getAllData" });
      const data = { version: 1, exportedAt: Date.now(), savedTabs: res.data.savedTabs, categories: res.data.categories };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tabbies-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export failed:", err);
    }
  });

  $("import-btn").addEventListener("click", () => {
    $("import-file-input").click();
  });

  $("import-file-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data.savedTabs) || !Array.isArray(data.categories)) {
        throw new Error("Invalid format: expected savedTabs and categories arrays");
      }
      if (!confirm(`Import ${data.savedTabs.length} tabs and ${data.categories.length} categories? This will replace all existing data.`)) return;
      await chrome.runtime.sendMessage({ action: "importData", data });
      await loadData();
      render();
    } catch (err) {
      alert("Import failed: " + err.message);
    }
    e.target.value = "";
  });

  function warnDuplicateUrl(url) {
    if (!url) return true;
    const savedForCurrentTab = state.activeTab ? state.savedTabs.find(t => t.activeTabId === state.activeTab.id) : null;
    const dup = state.savedTabs.find(t =>
      t.url === url &&
      t.id !== (savedForCurrentTab ? savedForCurrentTab.id : null)
    );
    if (dup) {
      return confirm(`"${dup.title}" is already saved with this URL. Save another copy?`);
    }
    return true;
  }

  $("search-input").addEventListener("input", () => {
    state.searchQuery = $("search-input").value;
    render();
  });

  document.querySelector(".filter-bar")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-btn");
    if (!btn) return;
    state.statusFilter = btn.dataset.filter;
    render();
  });

  $("save-category-select").addEventListener("change", () => {
    state.saveCategoryId = $("save-category-select").value || null;
  });

  $("sort-select").addEventListener("change", () => {
    state.sortBy = $("sort-select").value;
    render();
  });

  $("toggle-all-btn").addEventListener("click", async () => {
    const catIds = state.categories.map(c => c.id);
    if (state.categories.some(c => state.collapsed[c.id])) {
      catIds.forEach(id => delete state.collapsed[id]);
    } else {
      catIds.forEach(id => state.collapsed[id] = true);
    }
    await saveCollapsedState();
    render();
  });

  $("add-category-btn").addEventListener("click", () => openCategoryModal(null));

  $("modal-cancel").addEventListener("click", closeCategoryModal);
  document.querySelector(".modal-overlay")?.addEventListener("click", closeCategoryModal);

  $("modal-save").addEventListener("click", async () => {
    const name = $("category-name").value.trim();
    if (!name) return;
    const emoji = $("category-emoji").value.trim() || "📁";
    const color = document.querySelector(".color-option.selected")?.dataset.color || "#6b7280";
    try {
      if (editingCategoryId) {
        await chrome.runtime.sendMessage({ action: "updateCategory", id: editingCategoryId, name, emoji, color });
      } else {
        await chrome.runtime.sendMessage({ action: "createCategory", name, emoji, color });
      }
      closeCategoryModal();
      await loadData();
      render();
    } catch (err) {
      console.error("Category save failed:", err);
    }
  });

  $("undo-btn").addEventListener("click", async () => {
    if (!pendingUndo) return;
    clearUndo();
    try {
      await chrome.runtime.sendMessage({ action: "restoreSavedTabs", savedTabs: pendingUndo.savedTabs, categories: pendingUndo.categories });
      await loadData();
      render();
    } catch (err) {
      console.error("Undo failed:", err);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeCategoryModal(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = [...document.querySelectorAll(".tab-item")];
      if (items.length === 0) return;
      e.preventDefault();
      let idx = items.findIndex(el => el.classList.contains("selected"));
      if (idx === -1) idx = e.key === "ArrowDown" ? -1 : 0;
      idx = e.key === "ArrowDown"
        ? Math.min(idx + 1, items.length - 1)
        : Math.max(idx - 1, 0);
      document.querySelectorAll(".tab-item.selected").forEach(el => el.classList.remove("selected"));
      items[idx].classList.add("selected");
      items[idx].scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.key === "Enter") {
      const selected = document.querySelector(".tab-item.selected");
      if (!selected) return;
      e.preventDefault();
      const btn = selected.querySelector(".act-focusActiveTab, .act-openColdTab, .act-unshelveTab");
      if (btn) btn.click();
    }
  });
}

function initColorPicker() {
  const container = $("color-picker");
  COLORS.forEach((c) => {
    const el = document.createElement("button");
    el.className = "color-option";
    el.dataset.color = c;
    el.style.background = c;
    el.addEventListener("click", () => {
      container.querySelectorAll(".color-option").forEach((o) => o.classList.remove("selected"));
      el.classList.add("selected");
    });
    container.appendChild(el);
  });
}

function openCategoryModal(categoryId) {
  editingCategoryId = categoryId;
  $("modal-title").textContent = categoryId ? "Edit Category" : "Add Category";
  $("category-name").value = "";
  $("category-emoji").value = "";
  document.querySelectorAll(".color-option").forEach((o) => o.classList.remove("selected"));
  document.querySelector(".color-option")?.classList.add("selected");
  if (categoryId) {
    const cat = state.categories.find((c) => c.id === categoryId);
    if (cat) {
      $("category-name").value = cat.name;
      $("category-emoji").value = cat.emoji || "";
      const match = document.querySelector(`.color-option[data-color="${cat.color}"]`);
      if (match) match.classList.add("selected");
    }
  }
  $("category-modal").classList.remove("hidden");
  $("category-name").focus();
}

function closeCategoryModal() {
  $("category-modal").classList.add("hidden");
  editingCategoryId = null;
}

async function saveCollapsedState() {
  await chrome.storage.local.set({ collapsed: state.collapsed });
}

function extractDomain(url) {
  if (!url) return "";
  try { return new URL(url).hostname; } catch (e) { return ""; }
}

function relativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.floor(hrs / 24);
  if (days < 30) return days + "d ago";
  return Math.floor(days / 30) + "mo ago";
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
