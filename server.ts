import { join } from "path";

const PORT       = parseInt(process.env.PORT ?? "3000");
const MC_HOST    = "minecraft-angelo.cooked.mx";
const MC_PORT    = 25565;
const RCON_PORT  = parseInt(process.env.RCON_PORT ?? "25575");
const RCON_PASS  = process.env.RCON_PASSWORD ?? "";

// ── Types ─────────────────────────────────────────────────────

interface StatusResult {
  online: boolean;
  players?: { online: number; max: number };
  version?: string;
  tps?: number;
  mspt?: number;
}

// ── Cache ─────────────────────────────────────────────────────

let statusCache: { ts: number; data: StatusResult } | null = null;

// ── Minecraft server list ping ────────────────────────────────

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
      hostname: MC_HOST,
      port: MC_PORT,
      socket: {
        open(socket) {
          const handshakeData: number[] = [];
          handshakeData.push(0x00);
          writeVarInt(handshakeData, 767);
          writeString(handshakeData, MC_HOST);
          handshakeData.push((MC_PORT >> 8) & 0xff, MC_PORT & 0xff);
          writeVarInt(handshakeData, 1);

          const handshakePacket: number[] = [];
          writeVarInt(handshakePacket, handshakeData.length);
          handshakePacket.push(...handshakeData);

          socket.write(Buffer.from([...handshakePacket, 1, 0x00]));
        },
        data(socket, chunk) {
          chunks.push(Buffer.from(chunk));
          const data = Buffer.concat(chunks);
          const str  = data.toString("utf8");
          const start = str.indexOf("{");
          const end   = str.lastIndexOf("}");
          if (start !== -1 && end > start) {
            clearTimeout(timer);
            try {
              const json = JSON.parse(str.slice(start, end + 1));
              resolve({
                online: true,
                players: json.players
                  ? { online: json.players.online, max: json.players.max }
                  : undefined,
                version: json.version?.name,
              });
            } catch {
              resolve({ online: true });
            }
            socket.end();
          }
        },
        error(_s, _e) { clearTimeout(timer); resolve({ online: false }); },
        close() {},
        drain() {},
      },
    }).catch(() => { clearTimeout(timer); resolve({ online: false }); });
  });
}

// ── RCON client ───────────────────────────────────────────────
// Minecraft RCON protocol (https://wiki.vg/RCON)
// Packet: [length: i32le][request_id: i32le][type: i32le][payload: utf8 + \0\0]

const RCON_TYPE_LOGIN   = 3;
const RCON_TYPE_COMMAND = 2;
const RCON_TYPE_RESPONSE = 0;

function rconPacket(id: number, type: number, payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const len  = 4 + 4 + body.length + 2; // id + type + payload + \0\0
  const buf  = Buffer.alloc(4 + len);
  let off = 0;
  buf.writeInt32LE(len,  off); off += 4;
  buf.writeInt32LE(id,   off); off += 4;
  buf.writeInt32LE(type, off); off += 4;
  body.copy(buf, off);          off += body.length;
  buf.writeUInt8(0, off);       off += 1;
  buf.writeUInt8(0, off);
  return buf;
}

function parseRconPacket(buf: Buffer): { id: number; type: number; payload: string } | null {
  if (buf.length < 14) return null;
  const len  = buf.readInt32LE(0);
  if (buf.length < 4 + len) return null;
  const id   = buf.readInt32LE(4);
  const type = buf.readInt32LE(8);
  const payload = buf.slice(12, 4 + len - 2).toString("utf8");
  return { id, type, payload };
}

async function rconCommand(command: string): Promise<string | null> {
  if (!RCON_PASS) return null;

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { resolve(null); }, 4000);
    let   authed = false;

    Bun.connect({
      hostname: MC_HOST,
      port: RCON_PORT,
      socket: {
        open(socket) {
          socket.write(rconPacket(1, RCON_TYPE_LOGIN, RCON_PASS));
        },
        data(socket, chunk) {
          chunks.push(Buffer.from(chunk));
          const buf = Buffer.concat(chunks);

          if (!authed) {
            const pkt = parseRconPacket(buf);
            if (!pkt) return;
            if (pkt.id === -1) {
              // Wrong password
              clearTimeout(timer);
              console.error("[RCON] Authentication failed — check RCON_PASSWORD");
              resolve(null);
              socket.end();
              return;
            }
            authed = true;
            chunks.length = 0;
            socket.write(rconPacket(2, RCON_TYPE_COMMAND, command));
            return;
          }

          const pkt = parseRconPacket(buf);
          if (!pkt) return;
          clearTimeout(timer);
          resolve(pkt.payload);
          socket.end();
        },
        error(_s, _e) { clearTimeout(timer); resolve(null); },
        close() {},
        drain() {},
      },
    }).catch(() => { clearTimeout(timer); resolve(null); });
  });
}

// Parse Spark TPS output: strips colour codes, extracts the 1m TPS and MSPT
// Spark output looks like: "TPS from last 1m, 5m, 15m: *20.0, *20.0, *20.0 | MSPT from last 1m, 5m, 15m: *1.23, *1.45, *1.50"
function parseSparkTps(raw: string): { tps: number; mspt: number } | null {
  // Strip Minecraft colour codes (§X)
  const clean = raw.replace(/§[0-9a-fk-or]/gi, "").replace(/\*?/g, "");
  const tpsMatch  = clean.match(/TPS[^:]*:\s*([\d.]+)/i);
  const msptMatch = clean.match(/MSPT[^:]*:\s*([\d.]+)/i);
  if (!tpsMatch) return null;
  return {
    tps:  Math.min(20, parseFloat(tpsMatch[1])),
    mspt: msptMatch ? parseFloat(msptMatch[1]) : -1,
  };
}

async function fetchTps(): Promise<{ tps: number; mspt: number } | null> {
  const raw = await rconCommand("spark tps");
  if (!raw) return null;
  return parseSparkTps(raw);
}

// ── Static file serving ───────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css",
  ".js":   "text/javascript",
  ".json": "application/json",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff":  "font/woff",
  ".ttf":   "font/ttf",
};

function getMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

const publicDir = join(import.meta.dir, "public");

// ── HTTP server ───────────────────────────────────────────────

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url      = new URL(req.url);
    const pathname = url.pathname;
    const ts       = new Date().toISOString();

    console.log(`[${ts}] ${req.method} ${pathname}`);

    if (pathname === "/api/health") {
      return Response.json({ status: "ok", ts });
    }

    if (pathname === "/api/status") {
      const now = Date.now();
      if (statusCache && now - statusCache.ts < 25_000) {
        return Response.json(statusCache.data);
      }

      // Run ping and RCON TPS fetch in parallel
      const [ping, spark] = await Promise.all([
        pingMinecraft(),
        fetchTps(),
      ]);

      const result: StatusResult = { ...ping };
      if (ping.online && spark) {
        result.tps  = spark.tps;
        result.mspt = spark.mspt;
      }

      statusCache = { ts: now, data: result };
      return Response.json(result);
    }

    // Static files
    const safePath = pathname === "/" ? "/index.html" : pathname;
    const filePath = join(publicDir, safePath);
    if (!filePath.startsWith(publicDir)) {
      return new Response("Forbidden", { status: 403 });
    }

    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file, { headers: { "Content-Type": getMime(filePath) } });
    }

    return new Response(Bun.file(join(publicDir, "index.html")), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`Malarik Direwolf Guide running at http://localhost:${PORT}`);
if (RCON_PASS) {
  console.log(`RCON enabled → ${MC_HOST}:${RCON_PORT}`);
} else {
  console.log("RCON disabled — set RCON_PASSWORD env var to enable TPS stats");
}
