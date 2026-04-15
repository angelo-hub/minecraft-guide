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

  // ── Server health charts ──────────────────────────────────────

  const healthSection   = document.getElementById("health-section");
  const tpsChart        = document.getElementById("tps-chart");
  const msptChart       = document.getElementById("mspt-chart");
  const jvmRssChart     = document.getElementById("jvm-rss-chart");
  const ramAvailChart   = document.getElementById("ram-avail-chart");
  const tpsCurrent      = document.getElementById("tps-current");
  const msptCurrent     = document.getElementById("mspt-current");
  const jvmRssCurrent   = document.getElementById("jvm-rss-current");
  const ramAvailCurrent = document.getElementById("ram-avail-current");
  const jvmAnalysis     = document.getElementById("jvm-analysis");
  const rangeBtns       = document.querySelectorAll(".range-btn");

  let currentHours = 1;

  function tpsColor(tps) {
    if (tps >= 18) return "#22c55e";
    if (tps >= 14) return "#f59e0b";
    return "#ef4444";
  }

  function drawSparkline(svg, points, key, { min, max, color, refLines = [] }) {
    const W = 600, H = 64, padT = 10, padB = 6;
    const chartH = H - padT - padB;

    if (points.length < 2) {
      svg.innerHTML = `<text x="300" y="34" text-anchor="middle" fill="#505058"
        font-size="11" font-family="Space Grotesk, sans-serif">No data yet</text>`;
      return;
    }

    const minTs   = points[0].ts;
    const maxTs   = points[points.length - 1].ts;
    const tsRange = maxTs - minTs || 1;
    const valRange = max - min || 1;

    const xS = ts  => ((ts  - minTs) / tsRange)  * W;
    const yS = val => padT + (1 - Math.max(0, Math.min(1, (val - min) / valRange))) * chartH;

    let html = "";

    // Reference lines
    for (const { value, label } of refLines) {
      const y = yS(value).toFixed(1);
      html += `<line x1="0" y1="${y}" x2="${W}" y2="${y}"
        stroke="#2e2e38" stroke-width="1" stroke-dasharray="3,3"/>`;
      if (label) {
        html += `<text x="3" y="${(parseFloat(y) - 2).toFixed(1)}"
          fill="#48484f" font-size="9" font-family="Space Grotesk, sans-serif">${label}</text>`;
      }
    }

    // Build SVG path
    const linePath = points.map((p, i) =>
      `${i === 0 ? "M" : "L"}${xS(p.ts).toFixed(1)},${yS(p[key]).toFixed(1)}`
    ).join(" ");

    const firstX  = xS(points[0].ts).toFixed(1);
    const lastX   = xS(points[points.length - 1].ts).toFixed(1);
    const bottomY = (padT + chartH).toFixed(1);

    // Area fill
    html += `<path d="${linePath} L${lastX},${bottomY} L${firstX},${bottomY} Z"
      fill="${color}" opacity="0.07"/>`;

    // Line
    html += `<path d="${linePath}" fill="none" stroke="${color}"
      stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;

    // Latest value dot
    const last = points[points.length - 1];
    html += `<circle cx="${xS(last.ts).toFixed(1)}" cy="${yS(last[key]).toFixed(1)}"
      r="2.5" fill="${color}"/>`;

    svg.innerHTML = html;
  }

  async function loadStats(hours) {
    try {
      const res  = await fetch(`/api/stats?hours=${hours}`, { signal: AbortSignal.timeout(6000) });
      const data = await res.json();
      const pts  = data.points ?? [];

      if (pts.length === 0) return; // no RCON data yet — keep section hidden

      healthSection.style.display = "";

      // TPS chart
      const lastTps = pts[pts.length - 1].tps;
      const col     = tpsColor(lastTps);
      tpsCurrent.textContent = `${lastTps.toFixed(1)}`;
      tpsCurrent.style.color = col;
      drawSparkline(tpsChart, pts, "tps", {
        min: 0, max: 20, color: col,
        refLines: [{ value: 20, label: "20" }, { value: 15, label: "15" }],
      });

      // MSPT chart — cap Y axis at 2× the 95th-percentile to avoid outliers squashing the line
      const sorted   = [...pts].map(p => p.mspt).sort((a, b) => a - b);
      const p95      = sorted[Math.floor(sorted.length * 0.95)] ?? 50;
      const msptMax  = Math.max(50, Math.ceil(p95 * 2 / 10) * 10);
      const lastMspt = pts[pts.length - 1].mspt;
      msptCurrent.textContent = `${lastMspt.toFixed(1)}ms`;
      drawSparkline(msptChart, pts, "mspt", {
        min: 0, max: msptMax, color: "#22d3ee",
        refLines: [{ value: 50, label: "50ms" }, { value: 25, label: "25ms" }],
      });
    } catch { /* silently ignore — server may be unreachable */ }
  }

  // ── System history charts ──────────────────────────────────────

  function fmtMb(mb) {
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
  }

  async function loadSystemHistory(hours) {
    try {
      const res  = await fetch(`/api/system/history?hours=${hours}`, { signal: AbortSignal.timeout(6000) });
      const data = await res.json();
      const pts  = data.points ?? [];
      if (pts.length === 0) return;

      healthSection.style.display = "";

      // JVM RSS chart
      const hasJvm = pts.some(p => p.jvm_rss_mb !== null);
      if (hasJvm) {
        const jvmPts  = pts.filter(p => p.jvm_rss_mb !== null);
        const maxRss  = Math.max(...jvmPts.map(p => p.jvm_rss_mb));
        const yMax    = Math.ceil(maxRss * 1.2 / 512) * 512;
        const lastRss = jvmPts[jvmPts.length - 1].jvm_rss_mb;
        jvmRssCurrent.textContent = fmtMb(lastRss);
        drawSparkline(jvmRssChart, jvmPts, "jvm_rss_mb", {
          min: 0, max: yMax, color: "#a78bfa",
          refLines: yMax >= 4096
            ? [{ value: Math.round(yMax * 0.75), label: fmtMb(Math.round(yMax * 0.75)) }]
            : [],
        });
      }

      // Free RAM chart
      const maxAvail = Math.max(...pts.map(p => p.mem_avail_mb));
      const yMaxRam  = Math.ceil(maxAvail * 1.1 / 512) * 512;
      const lastAvail = pts[pts.length - 1].mem_avail_mb;
      const ramColor  = lastAvail < 1024 ? "#ef4444" : lastAvail < 2048 ? "#f59e0b" : "#22d3ee";
      ramAvailCurrent.textContent = fmtMb(lastAvail);
      ramAvailCurrent.style.color = ramColor;
      drawSparkline(ramAvailChart, pts, "mem_avail_mb", {
        min: 0, max: yMaxRam, color: ramColor,
        refLines: [{ value: 1024, label: "1 GB" }, { value: 2048, label: "2 GB" }],
      });
    } catch { /* silently ignore */ }
  }

  // ── JVM analysis panel ─────────────────────────────────────────

  async function loadJvmAnalysis() {
    try {
      const res  = await fetch("/api/system", { signal: AbortSignal.timeout(6000) });
      const snap = await res.json();
      if (!snap.mem) return;

      healthSection.style.display = "";

      const { mem, load, jvm } = snap;
      const cards   = [];
      const advice  = [];

      // Memory overview
      cards.push({ label: "System RAM", value: `${fmtMb(mem.usedMb)} / ${fmtMb(mem.totalMb)}`,
        sub: `${mem.usedPct}% used · ${fmtMb(mem.availMb)} free`,
        state: mem.availMb < 1024 ? "alert" : mem.availMb < 2048 ? "warn" : "good" });

      // Swap
      if (mem.swapTotalMb > 0) {
        const swapState = mem.swapUsedMb > 512 ? "alert" : mem.swapUsedMb > 0 ? "warn" : "good";
        cards.push({ label: "Swap", value: fmtMb(mem.swapUsedMb),
          sub: `of ${fmtMb(mem.swapTotalMb)} total`,
          state: swapState });
        if (mem.swapUsedMb > 0)
          advice.push({ text: `${fmtMb(mem.swapUsedMb)} of swap in use — the OS is paging memory to disk. Reduce -Xmx or add more RAM.`, alert: mem.swapUsedMb > 512 });
      }

      // Load average
      if (load) {
        cards.push({ label: "CPU Load (1m / 5m / 15m)", value: `${load.m1} / ${load.m5} / ${load.m15}`,
          sub: "lower is better", state: load.m1 > 4 ? "warn" : "good" });
      }

      // JVM-specific
      if (jvm) {
        cards.push({ label: `JVM RSS  (PID ${jvm.pid})`, value: fmtMb(jvm.rssMb),
          sub: "actual physical RAM used by Java",
          state: jvm.rssMb > (jvm.xmxMb ?? Infinity) * 1.1 ? "warn" : "good" });

        if (jvm.swapMb > 0) {
          cards.push({ label: "JVM Swapped", value: fmtMb(jvm.swapMb),
            sub: "portion of JVM paged to disk", state: "alert" });
          advice.push({ text: `JVM is swapping ${fmtMb(jvm.swapMb)} to disk — this will cause GC pause spikes. Reduce -Xmx or free system memory.`, alert: true });
        }

        if (jvm.xmxMb) {
          const headroomPct = Math.round(((jvm.xmxMb - jvm.rssMb) / jvm.xmxMb) * 100);
          cards.push({ label: "-Xmx (max heap)", value: fmtMb(jvm.xmxMb),
            sub: `~${headroomPct}% headroom vs current RSS`,
            state: headroomPct < 10 ? "alert" : headroomPct < 20 ? "warn" : "good" });
          if (headroomPct < 15)
            advice.push({ text: `JVM RSS is within ${headroomPct}% of -Xmx ${fmtMb(jvm.xmxMb)}. Consider increasing -Xmx or the GC will work overtime.`, alert: headroomPct < 10 });
          const freeAfterJvm = mem.totalMb - jvm.rssMb;
          if (freeAfterJvm > 2048 && headroomPct < 20)
            advice.push({ text: `You have ${fmtMb(freeAfterJvm)} of RAM not used by the JVM. You could safely raise -Xmx to ${fmtMb(jvm.xmxMb + 1024)} or more.`, alert: false });
        }

        if (jvm.xmsMb)
          cards.push({ label: "-Xms (initial heap)", value: fmtMb(jvm.xmsMb),
            sub: jvm.xmsMb === jvm.xmxMb ? "matches -Xmx — good, prevents resize GC" : "lower than -Xmx",
            state: jvm.xmsMb === jvm.xmxMb ? "good" : "good" });

        if (jvm.gc)
          cards.push({ label: "GC", value: jvm.gc,
            sub: jvm.gc === "G1GC" ? "recommended for Minecraft" : jvm.gc === "ZGC" ? "low-pause, good choice" : "",
            state: (jvm.gc === "G1GC" || jvm.gc === "ZGC" || jvm.gc === "Shenandoah") ? "good" : "warn" });
        else
          advice.push({ text: "No GC flag detected — Java will use its default. Add -XX:+UseG1GC for better Minecraft performance.", alert: false });

        if (jvm.flags.length > 0)
          cards.push({ label: "GC Tuning Flags", value: `${jvm.flags.length} set`,
            sub: jvm.flags.join(" · ").slice(0, 80) + (jvm.flags.join(" ").length > 80 ? "…" : ""),
            state: "good" });
      }

      let html = `<div class="jvm-analysis-grid">`;
      for (const c of cards) {
        html += `<div class="jvm-stat-card ${c.state ?? ''}">
          <div class="jvm-stat-label">${escapeHtml(c.label)}</div>
          <div class="jvm-stat-value">${escapeHtml(c.value)}</div>
          ${c.sub ? `<div class="jvm-stat-sub">${escapeHtml(c.sub)}</div>` : ''}
        </div>`;
      }
      html += `</div>`;
      for (const a of advice) {
        html += `<div class="jvm-advice${a.alert ? " alert" : ""}">⚠ ${escapeHtml(a.text)}</div>`;
      }

      jvmAnalysis.innerHTML = html;
      jvmAnalysis.style.display = "";
    } catch { /* silently ignore */ }
  }

  rangeBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      rangeBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentHours = parseInt(btn.dataset.hours);
      loadStats(currentHours);
      loadSystemHistory(currentHours);
    });
  });

  // Load on page open, refresh charts every 5 min, analysis every 60s
  loadStats(currentHours);
  loadSystemHistory(currentHours);
  loadJvmAnalysis();
  setInterval(() => { loadStats(currentHours); loadSystemHistory(currentHours); }, 5 * 60_000);
  setInterval(loadJvmAnalysis, 60_000);

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
