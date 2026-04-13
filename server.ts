import { join } from "path";

const PORT = parseInt(process.env.PORT ?? "3000");
const MC_HOST = "minecraft-angelo.cooked.mx";
const MC_PORT = 25565;

interface StatusResult {
  online: boolean;
  players?: { online: number; max: number };
  version?: string;
}

let statusCache: { ts: number; data: StatusResult } | null = null;

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

async function pingMinecraft(): Promise<StatusResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => resolve({ online: false }), 5000);

    Bun.connect({
      hostname: MC_HOST,
      port: MC_PORT,
      socket: {
        open(socket) {
          const handshakeData: number[] = [];
          handshakeData.push(0x00);          // packet ID
          writeVarInt(handshakeData, 767);   // protocol version (1.21.1)
          writeString(handshakeData, MC_HOST);
          handshakeData.push((MC_PORT >> 8) & 0xff, MC_PORT & 0xff);
          writeVarInt(handshakeData, 1);     // next state: status

          const handshakePacket: number[] = [];
          writeVarInt(handshakePacket, handshakeData.length);
          handshakePacket.push(...handshakeData);

          const statusRequest: number[] = [1, 0x00]; // length=1, packet ID=0x00

          socket.write(Buffer.from([...handshakePacket, ...statusRequest]));
        },
        data(socket, chunk) {
          chunks.push(Buffer.from(chunk));
          const data = Buffer.concat(chunks);
          const str = data.toString("utf8");
          const start = str.indexOf("{");
          const end = str.lastIndexOf("}");
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
        error(_socket, _err) {
          clearTimeout(timer);
          resolve({ online: false });
        },
        close() {},
        drain() {},
      },
    }).catch(() => {
      clearTimeout(timer);
      resolve({ online: false });
    });
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

function getMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

const publicDir = join(import.meta.dir, "public");

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const ts = new Date().toISOString();

    console.log(`[${ts}] ${req.method} ${pathname}`);

    if (pathname === "/api/health") {
      return Response.json({ status: "ok", ts });
    }

    if (pathname === "/api/status") {
      const now = Date.now();
      if (statusCache && now - statusCache.ts < 25_000) {
        return Response.json(statusCache.data);
      }
      const result = await pingMinecraft();
      statusCache = { ts: now, data: result };
      return Response.json(result);
    }

    // Static files
    const safePath = pathname === "/" ? "/index.html" : pathname;
    // Prevent path traversal
    const filePath = join(publicDir, safePath);
    if (!filePath.startsWith(publicDir)) {
      return new Response("Forbidden", { status: 403 });
    }

    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file, {
        headers: { "Content-Type": getMime(filePath) },
      });
    }

    // SPA fallback
    return new Response(Bun.file(join(publicDir, "index.html")), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`Malarik Direwolf Guide running at http://localhost:${PORT}`);
