const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280"];
const CAT_ICONS = ["📁", "💼", "🏠", "⭐", "❤️", "🎯", "📚", "🎮", "🎵", "✈️", "💡", "🛒"];

let state = { savedTabs: [], categories: [], activeTab: null };
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
    }
  } catch (e) {
    console.error("Failed to load data:", e);
  }
}

function render() {
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
  div.innerHTML = `
    <div class="category-header" style="--cat-color: ${category.color}">
      <span class="cat-emoji">${category.emoji || "📁"}</span>
      <span class="cat-name">${escapeHtml(category.name)}</span>
      <span class="cat-count">${tabs.length}</span>
      ${isBuiltIn ? "" : `
        <button class="cat-btn cat-edit" data-id="${category.id}" title="Edit Category">✎</button>
        <button class="cat-btn cat-delete" data-id="${category.id}" title="Delete Category">✕</button>
      `}
    </div>
    <div class="tab-list">${tabs.map((t) => renderTabItem(t)).join("")}</div>
  `;
  return div;
}

function renderTabItem(tab) {
  const actions = getActions(tab);
  const statusLabels = { active: "Active", hot: "Shelved", cold: "Cold" };
  return `
    <div class="tab-item" data-id="${escapeHtml(tab.id)}">
      <img class="favicon" src="${escapeHtml(tab.favIconUrl || "")}" onerror="this.style.display='none'" />
      <span class="tab-title" title="${escapeHtml(tab.title)}">${escapeHtml(tab.title)}</span>
      <span class="status-dot status-${tab.status}" title="${statusLabels[tab.status] || tab.status}"></span>
      <div class="tab-actions">
        ${actions.map((a) => `<button class="act-btn act-${a.action}" data-action="${a.action}" data-id="${escapeHtml(tab.id)}">${a.label}</button>`).join("")}
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

function bindEvents() {
  $("tab-list").addEventListener("click", async (e) => {
    const btn = e.target.closest(".act-btn");
    if (btn) {
      e.stopPropagation();
      const action = btn.dataset.action;
      const savedTabId = btn.dataset.id;
      try {
        await chrome.runtime.sendMessage({ action, savedTabId });
        await loadData();
        render();
      } catch (err) {
        console.error("Action failed:", err);
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
      const catId = state.categories.length > 0 ? state.categories[0].id : null;
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
      const catId = state.categories.length > 0 ? state.categories[0].id : null;
      await chrome.runtime.sendMessage({ action: "shelveActiveTab", tabId: state.activeTab.id, categoryId: catId });
      await loadData();
      render();
    } catch (err) {
      console.error("Shelve failed:", err);
    }
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
