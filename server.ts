import { join } from "path";
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";

const PORT      = parseInt(process.env.PORT ?? "3000");
const MC_HOST   = "minecraft-angelo.cooked.mx";
const MC_PORT   = 25565;
const RCON_PORT = parseInt(process.env.RCON_PORT ?? "25575");
const RCON_PASS = process.env.RCON_PASSWORD ?? "";

const SEVEN_DAYS_S = 7 * 24 * 3600;

// ── Types ─────────────────────────────────────────────────────

interface StatusResult {
  online: boolean;
  players?: { online: number; max: number };
  version?: string;
  tps?: number;
  mspt?: number;
}

interface StatPoint {
  ts: number;
  tps: number;
  mspt: number;
}

interface MemInfo {
  totalMb: number;
  availMb: number;
  usedMb: number;
  usedPct: number;
  swapTotalMb: number;
  swapUsedMb: number;
  swapUsedPct: number;
}

interface JvmInfo {
  pid: number;
  rssMb: number;
  swapMb: number;
  xmxMb: number | null;
  xmsMb: number | null;
  gc: string | null;
  flags: string[];
}

interface SystemSnapshot {
  mem: MemInfo | null;
  load: { m1: number; m5: number; m15: number } | null;
  jvm: JvmInfo | null;
}

interface SystemStatPoint {
  ts: number;
  mem_used_mb: number;
  mem_avail_mb: number;
  swap_used_mb: number;
  load_1m: number;
  jvm_rss_mb: number | null;
  jvm_swap_mb: number | null;
}

// ── SQLite ────────────────────────────────────────────────────

mkdirSync(join(import.meta.dir, "data"), { recursive: true });

const db = new Database(join(import.meta.dir, "data/stats.db"));

// Performance pragmas — applied once at startup
db.exec(`
  PRAGMA journal_mode = WAL;        -- concurrent reads during writes, less fsync
  PRAGMA synchronous  = NORMAL;     -- safe with WAL, much faster than FULL
  PRAGMA cache_size   = -8000;      -- 8 MB page cache (negative = kibibytes)
  PRAGMA temp_store   = MEMORY;     -- temp tables/indexes in RAM
  PRAGMA mmap_size    = 134217728;  -- 128 MB memory-mapped I/O
  PRAGMA auto_vacuum  = INCREMENTAL;-- reclaim space from 7-day pruning gradually
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS stats (
    ts   INTEGER PRIMARY KEY,
    tps  REAL NOT NULL,
    mspt REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ts ON stats(ts);

  CREATE TABLE IF NOT EXISTS system_stats (
    ts           INTEGER PRIMARY KEY,
    mem_used_mb  INTEGER NOT NULL,
    mem_avail_mb INTEGER NOT NULL,
    swap_used_mb INTEGER NOT NULL,
    load_1m      REAL    NOT NULL,
    jvm_rss_mb   INTEGER,
    jvm_swap_mb  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sys_ts ON system_stats(ts);
`);

const stmtInsertTps    = db.prepare(`INSERT OR REPLACE INTO stats (ts, tps, mspt) VALUES (?, ?, ?)`);
const stmtPruneTps     = db.prepare(`DELETE FROM stats WHERE ts < ?`);
const stmtInsertSys    = db.prepare(`
  INSERT OR REPLACE INTO system_stats
    (ts, mem_used_mb, mem_avail_mb, swap_used_mb, load_1m, jvm_rss_mb, jvm_swap_mb)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);
const stmtPruneSys     = db.prepare(`DELETE FROM system_stats WHERE ts < ?`);

// Bucket sizes → keep ~120-200 points per range
const BUCKET: Record<number, number> = {
  1:   60,    // 1h  → 1-min buckets
  6:   300,   // 6h  → 5-min buckets
  24:  900,   // 24h → 15-min buckets
  168: 3600,  // 7d  → 1-hour buckets
};

function queryTpsStats(hours: number): StatPoint[] {
  const b = BUCKET[hours] ?? 3600;
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  return db.query<StatPoint, [number, number, number, number]>(`
    SELECT (ts/?) * ? AS ts,
           ROUND(AVG(tps), 2)  AS tps,
           ROUND(AVG(mspt), 2) AS mspt
    FROM stats WHERE ts > ?
    GROUP BY ts/? ORDER BY ts ASC
  `).all(b, b, since, b);
}

function querySysStats(hours: number): SystemStatPoint[] {
  const b = BUCKET[hours] ?? 3600;
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  return db.query<SystemStatPoint, [number, number, number, number]>(`
    SELECT (ts/?) * ? AS ts,
           ROUND(AVG(mem_used_mb))  AS mem_used_mb,
           ROUND(AVG(mem_avail_mb)) AS mem_avail_mb,
           ROUND(AVG(swap_used_mb)) AS swap_used_mb,
           ROUND(AVG(load_1m), 2)   AS load_1m,
           ROUND(AVG(jvm_rss_mb))   AS jvm_rss_mb,
           ROUND(AVG(jvm_swap_mb))  AS jvm_swap_mb
    FROM system_stats WHERE ts > ?
    GROUP BY ts/? ORDER BY ts ASC
  `).all(b, b, since, b);
}

function recordTps(tps: number, mspt: number): void {
  const ts = Math.floor(Date.now() / 1000);
  stmtInsertTps.run(ts, tps, mspt);
  stmtPruneTps.run(ts - SEVEN_DAYS_S);
}

function recordSys(snap: SystemSnapshot): void {
  if (!snap.mem || !snap.load) return;
  const ts = Math.floor(Date.now() / 1000);
  stmtInsertSys.run(
    ts,
    snap.mem.usedMb,
    snap.mem.availMb,
    snap.mem.swapUsedMb,
    snap.load.m1,
    snap.jvm?.rssMb ?? null,
    snap.jvm?.swapMb ?? null,
  );
  stmtPruneSys.run(ts - SEVEN_DAYS_S);
}

// ── System stats (Linux /proc) ────────────────────────────────

async function readProcFile(path: string): Promise<string> {
  try { return await Bun.file(path).text(); }
  catch { return ""; }
}

async function getMemInfo(): Promise<MemInfo | null> {
  const text = await readProcFile("/proc/meminfo");
  if (!text) return null;
  const kv: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) kv[m[1]] = parseInt(m[2]); // kB
  }
  const total     = (kv.MemTotal     ?? 0) / 1024;
  const avail     = (kv.MemAvailable ?? 0) / 1024;
  const used      = total - avail;
  const swapTotal = (kv.SwapTotal    ?? 0) / 1024;
  const swapFree  = (kv.SwapFree     ?? 0) / 1024;
  const swapUsed  = swapTotal - swapFree;
  if (total === 0) return null;
  return {
    totalMb:     Math.round(total),
    availMb:     Math.round(avail),
    usedMb:      Math.round(used),
    usedPct:     Math.round((used / total) * 100),
    swapTotalMb: Math.round(swapTotal),
    swapUsedMb:  Math.round(swapUsed),
    swapUsedPct: swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0,
  };
}

async function getLoadAvg(): Promise<{ m1: number; m5: number; m15: number } | null> {
  const text = await readProcFile("/proc/loadavg");
  if (!text) return null;
  const parts = text.split(" ");
  if (parts.length < 3) return null;
  return { m1: parseFloat(parts[0]), m5: parseFloat(parts[1]), m15: parseFloat(parts[2]) };
}

async function spawnRead(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text.trim();
  } catch { return ""; }
}

async function findMinecraftPid(): Promise<number | null> {
  // Try patterns that match a NeoForge/Forge server process
  for (const pattern of ["neoforge", "forge", "minecraft_server", "server.jar"]) {
    const out = await spawnRead(["pgrep", "-f", pattern]);
    const pid = parseInt(out.split("\n")[0]);
    if (!isNaN(pid) && pid > 0) return pid;
  }
  return null;
}

function parseMbArg(val: string): number | null {
  const m = val.match(/^(\d+(?:\.\d+)?)([kmgKMG]?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case "k": return Math.round(n / 1024);
    case "m": return Math.round(n);
    case "g": return Math.round(n * 1024);
    default:  return Math.round(n / 1024 / 1024); // bytes → MB
  }
}

async function getJvmInfo(pid: number): Promise<JvmInfo | null> {
  const statusText = await readProcFile(`/proc/${pid}/status`);
  if (!statusText) return null;

  const kv: Record<string, number> = {};
  for (const line of statusText.split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+)\s+kB/);
    if (m) kv[m[1]] = parseInt(m[2]);
  }

  const rssMb  = Math.round((kv.VmRSS  ?? 0) / 1024);
  const swapMb = Math.round((kv.VmSwap ?? 0) / 1024);

  const cmdline = await readProcFile(`/proc/${pid}/cmdline`);
  const args    = cmdline.split("\0").filter(Boolean);

  let xmxMb: number | null = null;
  let xmsMb: number | null = null;
  let gc: string | null = null;
  const flags: string[] = [];

  for (const arg of args) {
    if      (arg.startsWith("-Xmx"))                  xmxMb = parseMbArg(arg.slice(4));
    else if (arg.startsWith("-Xms"))                  xmsMb = parseMbArg(arg.slice(4));
    else if (arg === "-XX:+UseG1GC")                  gc = "G1GC";
    else if (arg === "-XX:+UseZGC")                   gc = "ZGC";
    else if (arg === "-XX:+UseShenandoahGC")          gc = "Shenandoah";
    else if (arg === "-XX:+UseParallelGC")            gc = "ParallelGC";
    else if (arg === "-XX:+UseSerialGC")              gc = "SerialGC";
    else if (arg.startsWith("-XX:") && (
      arg.includes("GCPause") || arg.includes("GCThread") ||
      arg.includes("HeapRegion") || arg.includes("NewSize") ||
      arg.includes("SurvivorRatio") || arg.includes("ReservePercent") ||
      arg.includes("InitiatingHeap") || arg.includes("ParallelRef")
    )) flags.push(arg);
  }

  return { pid, rssMb, swapMb, xmxMb, xmsMb, gc, flags };
}

// Cache the PID so we don't pgrep on every poll — re-find if it goes away
let cachedPid: number | null = null;

async function gatherSystemSnapshot(): Promise<SystemSnapshot> {
  const [mem, load] = await Promise.all([getMemInfo(), getLoadAvg()]);

  // Find JVM process
  if (cachedPid !== null) {
    // Verify process is still alive
    const check = await readProcFile(`/proc/${cachedPid}/status`);
    if (!check) cachedPid = null;
  }
  if (cachedPid === null) {
    cachedPid = await findMinecraftPid();
  }

  const jvm = cachedPid !== null ? await getJvmInfo(cachedPid) : null;
  return { mem, load, jvm };
}

// ── MC server list ping ───────────────────────────────────────

function writeVarInt(buf: number[], value: number): void {
  value = value >>> 0;
  do {
    let temp = value & 0x7f;
    value >>>= 7;
    if (value !== 0) temp |= 0x80;
    buf.push(temp);
  } while (value !== 0);
}

function writeString(buf: number[], str: string): void {
  const bytes = Buffer.from(str, "utf8");
  writeVarInt(buf, bytes.length);
  for (const b of bytes) buf.push(b);
}

async function pingMinecraft(): Promise<Omit<StatusResult, "tps" | "mspt">> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => resolve({ online: false }), 5000);
    Bun.connect({
      hostname: MC_HOST, port: MC_PORT,
      socket: {
        open(socket) {
          const hd: number[] = [];
          hd.push(0x00); writeVarInt(hd, 767); writeString(hd, MC_HOST);
          hd.push((MC_PORT >> 8) & 0xff, MC_PORT & 0xff); writeVarInt(hd, 1);
          const hp: number[] = []; writeVarInt(hp, hd.length); hp.push(...hd);
          socket.write(Buffer.from([...hp, 1, 0x00]));
        },
        data(socket, chunk) {
          chunks.push(Buffer.from(chunk));
          const str = Buffer.concat(chunks).toString("utf8");
          const s = str.indexOf("{"), e = str.lastIndexOf("}");
          if (s !== -1 && e > s) {
            clearTimeout(timer);
            try {
              const j = JSON.parse(str.slice(s, e + 1));
              resolve({ online: true,
                players: j.players ? { online: j.players.online, max: j.players.max } : undefined,
                version: j.version?.name });
            } catch { resolve({ online: true }); }
            socket.end();
          }
        },
        error(_s, _e) { clearTimeout(timer); resolve({ online: false }); },
        close() {}, drain() {},
      },
    }).catch(() => { clearTimeout(timer); resolve({ online: false }); });
  });
}

// ── RCON client ───────────────────────────────────────────────

function rconPacket(id: number, type: number, payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const len  = 4 + 4 + body.length + 2;
  const buf  = Buffer.alloc(4 + len);
  let o = 0;
  buf.writeInt32LE(len,  o); o += 4;
  buf.writeInt32LE(id,   o); o += 4;
  buf.writeInt32LE(type, o); o += 4;
  body.copy(buf, o); o += body.length;
  buf.writeUInt8(0, o++); buf.writeUInt8(0, o);
  return buf;
}

function parseRconPacket(buf: Buffer) {
  if (buf.length < 14) return null;
  const len = buf.readInt32LE(0);
  if (buf.length < 4 + len) return null;
  return { id: buf.readInt32LE(4), type: buf.readInt32LE(8),
           payload: buf.slice(12, 4 + len - 2).toString("utf8") };
}

async function rconCommand(command: string): Promise<string | null> {
  if (!RCON_PASS) return null;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => resolve(null), 4000);
    let authed = false;
    Bun.connect({
      hostname: MC_HOST, port: RCON_PORT,
      socket: {
        open(s) { s.write(rconPacket(1, 3, RCON_PASS)); },
        data(s, chunk) {
          chunks.push(Buffer.from(chunk));
          const buf = Buffer.concat(chunks);
          if (!authed) {
            const pkt = parseRconPacket(buf);
            if (!pkt) return;
            if (pkt.id === -1) {
              clearTimeout(timer);
              console.error("[RCON] Auth failed — check RCON_PASSWORD");
              resolve(null); s.end(); return;
            }
            authed = true; chunks.length = 0;
            s.write(rconPacket(2, 2, command));
            return;
          }
          const pkt = parseRconPacket(buf);
          if (!pkt) return;
          clearTimeout(timer); resolve(pkt.payload); s.end();
        },
        error(_s, _e) { clearTimeout(timer); resolve(null); },
        close() {}, drain() {},
      },
    }).catch(() => { clearTimeout(timer); resolve(null); });
  });
}

function parseSparkTps(raw: string): { tps: number; mspt: number } | null {
  const clean = raw.replace(/§[0-9a-fk-or]/gi, "").replace(/\*/g, "");
  const tm = clean.match(/TPS[^:]*:\s*([\d.]+)/i);
  const mm = clean.match(/MSPT[^:]*:\s*([\d.]+)/i);
  if (!tm) return null;
  return { tps: Math.min(20, parseFloat(tm[1])), mspt: mm ? parseFloat(mm[1]) : -1 };
}

async function fetchTps(): Promise<{ tps: number; mspt: number } | null> {
  const raw = await rconCommand("spark tps");
  return raw ? parseSparkTps(raw) : null;
}

// ── Background polling ────────────────────────────────────────

async function backgroundPoll(): Promise<void> {
  // System stats — always, no RCON needed
  try {
    const snap = await gatherSystemSnapshot();
    recordSys(snap);
  } catch (e) {
    console.error("[system poll]", e);
  }

  // TPS via RCON — only if configured
  if (RCON_PASS) {
    try {
      const spark = await fetchTps();
      if (spark) recordTps(spark.tps, spark.mspt);
    } catch { /* MC may be restarting */ }
  }
}

setTimeout(() => {
  backgroundPoll();
  setInterval(backgroundPoll, 60_000);
}, 10_000);

// ── Cache ─────────────────────────────────────────────────────

let statusCache: { ts: number; data: StatusResult } | null = null;

// ── Static file serving ───────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css",
  ".js": "text/javascript", ".json": "application/json",
  ".ico": "image/x-icon", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
};
function getMime(p: string) { return MIME[p.slice(p.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream"; }

const publicDir = join(import.meta.dir, "public");

// ── HTTP server ───────────────────────────────────────────────

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url      = new URL(req.url);
    const pathname = url.pathname;
    console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);

    if (pathname === "/api/health") {
      return Response.json({ status: "ok", ts: new Date().toISOString() });
    }

    if (pathname === "/api/status") {
      const now = Date.now();
      if (statusCache && now - statusCache.ts < 25_000) return Response.json(statusCache.data);
      const [ping, spark] = await Promise.all([pingMinecraft(), fetchTps()]);
      const result: StatusResult = { ...ping };
      if (ping.online && spark) { result.tps = spark.tps; result.mspt = spark.mspt; }
      statusCache = { ts: now, data: result };
      return Response.json(result);
    }

    if (pathname === "/api/stats") {
      const hours = validateHours(url.searchParams.get("hours"));
      return Response.json({ points: queryTpsStats(hours), hours });
    }

    if (pathname === "/api/system") {
      // Live snapshot — not cached, caller throttles
      const snap = await gatherSystemSnapshot();
      return Response.json(snap);
    }

    if (pathname === "/api/system/history") {
      const hours = validateHours(url.searchParams.get("hours"));
      return Response.json({ points: querySysStats(hours), hours });
    }

    // Static files
    const safePath = pathname === "/" ? "/index.html" : pathname;
    const filePath = join(publicDir, safePath);
    if (!filePath.startsWith(publicDir)) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(filePath);
    if (await file.exists()) return new Response(file, { headers: { "Content-Type": getMime(filePath) } });
    return new Response(Bun.file(join(publicDir, "index.html")), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
});

function validateHours(raw: string | null): number {
  const n = parseInt(raw ?? "1");
  return [1, 6, 24, 168].includes(n) ? n : 1;
}

console.log(`Malarik Direwolf Guide → http://localhost:${PORT}`);
console.log(`System stats: polling every 60s, retaining 7 days`);
console.log(RCON_PASS
  ? `RCON: enabled → ${MC_HOST}:${RCON_PORT}`
  : `RCON: disabled (set RCON_PASSWORD in .env to enable TPS stats)`);
