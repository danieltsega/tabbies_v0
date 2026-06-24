const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280"];
const CAT_ICONS = ["📁", "💼", "🏠", "⭐", "❤️", "🎯", "📚", "🎮", "🎵", "✈️", "💡", "🛒"];

let state = { savedTabs: [], categories: [], activeTab: null, saveCategoryId: null };
let editingCategoryId = null;

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  initColorPicker();
  await loadData();
  render();
  bindEvents();
});

async function loadData() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.activeTab = tab ? { id: tab.id, url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl } : null;
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

function render() {
  renderActionBar();
  const container = $("tab-list");
  container.innerHTML = "";
  if (state.savedTabs.length === 0) {
    container.innerHTML = `<div class="empty-state">No saved tabs yet.<br>Use the buttons above to save or shelve your current tab.</div>`;
    return;
  }
  const catIds = new Set(state.categories.map((c) => c.id));
  state.categories.forEach((cat) => {
    const tabs = state.savedTabs.filter((t) => t.categoryId === cat.id);
    container.appendChild(renderCategory(cat, tabs));
  });
  const uncategorized = state.savedTabs.filter((t) => !catIds.has(t.categoryId));
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
  div.innerHTML = `
    <div class="category-header" draggable="${isBuiltIn ? "false" : "true"}" data-category-id="${category.id}" style="--cat-color: ${category.color}">
      <span class="cat-emoji">${category.emoji || "📁"}</span>
      <span class="cat-name">${escapeHtml(category.name)}</span>
      <span class="cat-count">${tabs.length}</span>
      ${coldCount > 0 ? `<button class="cat-btn cat-open-all" data-id="${category.id}" title="Open all cold tabs (${coldCount})">▶ ${coldCount}</button>` : ""}
      ${isBuiltIn ? "" : `
        <button class="cat-btn cat-edit" data-id="${category.id}" title="Edit Category">✎</button>
        <button class="cat-btn cat-delete" data-id="${category.id}" title="Delete Category">✕</button>
      `}
    </div>
    <div class="tab-list" data-category-id="${category.id}">${tabs.map((t) => renderTabItem(t)).join("")}</div>
  `;
  return div;
}

function renderTabItem(tab) {
  const actions = getActions(tab);
  const statusLabels = { active: "Active", hot: "Shelved", cold: "Cold" };
  return `
    <div class="tab-item" draggable="true" data-id="${escapeHtml(tab.id)}" data-category="${escapeHtml(tab.categoryId || "")}">
      <img class="favicon" src="${escapeHtml(tab.favIconUrl || "")}" onerror="this.style.display='none'" />
      <span class="tab-title" title="${escapeHtml(tab.title)}">${escapeHtml(tab.title)}</span>
      <span class="status-dot status-${tab.status}" title="${statusLabels[tab.status] || tab.status}"></span>
      <div class="tab-actions">
        ${state.categories.length > 0 ? categorySelectHTML(tab) : ""}
        ${actions.map((a) => `<button class="act-btn act-${a.action}" data-action="${a.action}" data-id="${escapeHtml(tab.id)}">${a.label}</button>`).join("")}
      </div>
    </div>
  `;
}

function categorySelectHTML(tab) {
  const options = state.categories.map(c =>
    `<option value="${escapeHtml(c.id)}" ${c.id === tab.categoryId ? "selected" : ""}>${escapeHtml(c.emoji || "📁")} ${escapeHtml(c.name)}</option>`
  ).join("");
  const hasMatchingCat = tab.categoryId && state.categories.some(c => c.id === tab.categoryId);
  return `<select class="cat-select" data-id="${escapeHtml(tab.id)}" title="Move to category">
    <option value="" ${hasMatchingCat ? "" : "selected"}>No category</option>
    ${options}
  </select>`;
}

function getActions(tab) {
  switch (tab.status) {
    case "active":
      return [
        { action: "focusActiveTab", label: "Focus" },
        { action: "shelveSavedTab", label: "Shelve" },
        { action: "removeSavedTab", label: "Remove" },
      ];
    case "hot":
      return [
        { action: "unshelveTab", label: "Unshelve" },
        { action: "removeSavedTab", label: "Remove" },
      ];
    case "cold":
      return [
        { action: "openColdTab", label: "Open" },
        { action: "removeSavedTab", label: "Remove" },
      ];
    default:
      return [{ action: "removeSavedTab", label: "Remove" }];
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

  $("tab-list").addEventListener("click", async (e) => {
    const btn = e.target.closest(".act-btn");
    if (btn) {
      e.stopPropagation();
      const action = btn.dataset.action;
      const savedTabId = btn.dataset.id;
      if (action === "removeSavedTab" && !confirm("Remove this saved tab?")) return;
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

  $("save-category-select").addEventListener("change", () => {
    state.saveCategoryId = $("save-category-select").value || null;
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

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeCategoryModal();
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

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
