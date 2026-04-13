/* ============================================================
   Malarik Direwolf — app.js
   Tabs · Search · FAQ accordion · Server status
   ============================================================ */

(function () {
  "use strict";

  // ── Tab switching ─────────────────────────────────────────────

  const tabBtns   = document.querySelectorAll(".tab-btn");
  const tabPanels = document.querySelectorAll(".tab-panel");
  let   activeTab = "getting-started";

  function showTab(name) {
    activeTab = name;
    tabBtns.forEach(btn => {
      const active = btn.dataset.tab === name;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    tabPanels.forEach(panel => {
      panel.classList.toggle("active", panel.id === "tab-" + name);
    });
  }

  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      clearSearch();
      showTab(btn.dataset.tab);
    });
  });

  // ── FAQ accordion ─────────────────────────────────────────────

  document.querySelectorAll(".faq-question").forEach(btn => {
    btn.addEventListener("click", () => {
      const isOpen = btn.classList.contains("open");
      // Close all
      document.querySelectorAll(".faq-question").forEach(q => {
        q.classList.remove("open");
        q.setAttribute("aria-expanded", "false");
        q.nextElementSibling.classList.remove("open");
      });
      // Open clicked (toggle)
      if (!isOpen) {
        btn.classList.add("open");
        btn.setAttribute("aria-expanded", "true");
        btn.nextElementSibling.classList.add("open");
      }
    });
  });

  // ── Search ────────────────────────────────────────────────────

  const searchInput   = document.getElementById("search");
  const searchResults = document.getElementById("search-results");

  // Build an index from .searchable elements at page load
  const index = [];
  document.querySelectorAll(".searchable").forEach(el => {
    index.push({
      el,
      tab:   el.dataset.tab   || "Unknown",
      title: el.dataset.title || el.querySelector("h2,h3,h4")?.textContent?.trim() || "",
      text:  el.textContent.toLowerCase(),
      raw:   el.textContent,
    });
  });

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function highlight(text, query) {
    if (!query) return text;
    const re = new RegExp("(" + escapeRegex(query) + ")", "gi");
    return text.replace(re, "<mark>$1</mark>");
  }

  function getExcerpt(raw, query, maxLen = 120) {
    const lower = raw.toLowerCase();
    const idx   = lower.indexOf(query.toLowerCase());
    if (idx === -1) return raw.slice(0, maxLen) + (raw.length > maxLen ? "…" : "");
    const start  = Math.max(0, idx - 40);
    const end    = Math.min(raw.length, idx + query.length + 80);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < raw.length ? "…" : "";
    return prefix + raw.slice(start, end) + suffix;
  }

  function renderSearchResults(query) {
    const q = query.trim().toLowerCase();
    if (!q) {
      clearSearch();
      return;
    }

    // Hide tab panels, show results
    tabPanels.forEach(p => p.classList.remove("active"));
    searchResults.classList.add("active");

    const matches = index.filter(item => item.text.includes(q));

    if (matches.length === 0) {
      searchResults.innerHTML = `<div class="no-results">No results for "<strong>${escapeHtml(query)}</strong>"</div>`;
      return;
    }

    // Group by tab
    const groups = {};
    matches.forEach(item => {
      if (!groups[item.tab]) groups[item.tab] = [];
      groups[item.tab].push(item);
    });

    let html = "";
    Object.entries(groups).forEach(([tab, items]) => {
      html += `<div class="search-result-group">`;
      html += `<div class="search-result-group-label">${escapeHtml(tab)}</div>`;
      items.forEach(item => {
        const excerpt  = getExcerpt(item.raw, query);
        const hlTitle  = highlight(escapeHtml(item.title), escapeHtml(query));
        const hlExcerpt = highlight(escapeHtml(excerpt), escapeHtml(query));
        // We store the tab name in a data attribute to jump to it
        const tabKey = TAB_MAP[tab] || "getting-started";
        html += `
          <div class="search-result-item" data-target-tab="${tabKey}" role="button" tabindex="0">
            <div class="search-result-title">${hlTitle}</div>
            <div class="search-result-excerpt">${hlExcerpt}</div>
          </div>`;
      });
      html += `</div>`;
    });

    searchResults.innerHTML = html;

    // Click to jump to tab
    searchResults.querySelectorAll(".search-result-item").forEach(item => {
      const handler = () => {
        clearSearch();
        showTab(item.dataset.targetTab);
      };
      item.addEventListener("click", handler);
      item.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") handler(); });
    });
  }

  const TAB_MAP = {
    "Getting Started": "getting-started",
    "Mods Guide":      "mods",
    "Commands":        "commands",
    "FAQ":             "faq",
  };

  function clearSearch() {
    searchInput.value = "";
    searchResults.classList.remove("active");
    searchResults.innerHTML = "";
    showTab(activeTab);
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  let searchTimer;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderSearchResults(searchInput.value), 120);
  });

  searchInput.addEventListener("keydown", e => {
    if (e.key === "Escape") clearSearch();
  });

  // ── Server status ─────────────────────────────────────────────

  const statusDot     = document.getElementById("status-dot");
  const statusText    = document.getElementById("status-text");
  const statusPlayers = document.getElementById("status-players");
  const statusDivider = document.getElementById("status-divider");
  const statusTps     = document.getElementById("status-tps");
  const statusMspt    = document.getElementById("status-mspt");

  function clearStats() {
    statusPlayers.textContent = "";
    statusDivider.className   = "status-divider";
    statusTps.textContent     = "";
    statusTps.className       = "";
    statusMspt.textContent    = "";
  }

  async function fetchStatus() {
    statusDot.className = "status-dot checking";
    try {
      const res  = await fetch("/api/status", { signal: AbortSignal.timeout(8000) });
      const data = await res.json();

      if (data.online) {
        statusDot.className    = "status-dot online";
        statusText.textContent = "Online";

        if (data.players !== undefined) {
          statusPlayers.textContent = `· ${data.players.online}/${data.players.max}`;
        } else {
          statusPlayers.textContent = "";
        }

        if (data.tps !== undefined) {
          statusDivider.className = "status-divider visible";

          const tps = data.tps;
          statusTps.textContent = `${tps.toFixed(1)} TPS`;
          statusTps.className   = tps >= 18 ? "tps-good" : tps >= 14 ? "tps-warn" : "tps-bad";

          if (data.mspt !== undefined && data.mspt >= 0) {
            statusMspt.textContent = `· ${data.mspt.toFixed(1)}ms`;
          } else {
            statusMspt.textContent = "";
          }
        } else {
          statusDivider.className = "status-divider";
          statusTps.textContent   = "";
          statusMspt.textContent  = "";
        }
      } else {
        statusDot.className    = "status-dot offline";
        statusText.textContent = "Offline";
        clearStats();
      }
    } catch {
      statusDot.className    = "status-dot offline";
      statusText.textContent = "Unknown";
      clearStats();
    }
  }

  fetchStatus();
  setInterval(fetchStatus, 30_000);

})();
