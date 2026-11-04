// Loja VIP do WitherCraft: Pix (Mercado Pago) + entrega automática no servidor.
// Node 18+ · nenhuma dependência para instalar:  node server.mjs
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDiscord } from "./discord.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- config (.env)
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}
const env = (k, d = "") => process.env[k] ?? d;
const CFG = {
  port: Number(env("PORT", "3000")),
  publicUrl: env("PUBLIC_URL").replace(/\/+$/, ""),
  mpToken: env("MP_ACCESS_TOKEN"),
  mpApi: env("MP_API", "https://api.mercadopago.com").replace(/\/+$/, ""),
  delivery: env("DELIVERY_MODE", "ptero"), // ptero = manda o comando pelo painel | manual = você copia no admin
  pteroUrl: env("PTERO_URL").replace(/\/+$/, ""),
  pteroKey: env("PTERO_API_KEY"),
  pteroServer: env("PTERO_SERVER_ID"),
  adminPassword: env("ADMIN_PASSWORD"),
  discordWebhook: env("DISCORD_WEBHOOK_URL").trim(),
  dataDir: path.resolve(ROOT, env("DATA_DIR", "data")),
  trustProxy: env("TRUST_PROXY") === "1",
  pixMinutes: Number(env("PIX_MINUTES", "30")),
};
const PRODUCTS = JSON.parse(fs.readFileSync(path.join(ROOT, "products.json"), "utf8"));
const tierById = new Map(PRODUCTS.tiers.map((t) => [t.id, t]));

// ---------------------------------------------------------------- pedidos (arquivo JSON)
fs.mkdirSync(CFG.dataDir, { recursive: true });
const ORDERS_FILE = path.join(CFG.dataDir, "orders.json");
let orders = {};
try {
  orders = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
} catch {}
function saveOrders() {
  const tmp = ORDERS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(orders, null, 1));
  fs.renameSync(tmp, ORDERS_FILE);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const money = (n) => Number(Number(n).toFixed(2));
const discord = createDiscord({ webhook: CFG.discordWebhook, orders, saveOrders, tierById, log });

// ---------------------------------------------------------------- Mercado Pago
async function mp(method, url, body, idem) {
  const res = await fetch(CFG.mpApi + url, {
    method,
    headers: {
      Authorization: `Bearer ${CFG.mpToken}`,
      "Content-Type": "application/json",
      ...(idem ? { "X-Idempotency-Key": idem } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Mercado Pago ${res.status}: ${data.message || JSON.stringify(data).slice(0, 200)}`);
  return data;
}

const mpDate = (ms) => new Date(ms).toISOString().replace("Z", "+00:00");

async function createPix(order, tier, planLabel) {
  const pay = await mp(
    "POST",
    "/v1/payments",
    {
      transaction_amount: order.amount,
      description: `VIP ${tier.name} (${planLabel}) - ${order.nick}`,
      payment_method_id: "pix",
      payer: { email: order.email },
      external_reference: order.id,
      date_of_expiration: mpDate(Date.now() + CFG.pixMinutes * 60000),
      ...(CFG.publicUrl.startsWith("https://") ? { notification_url: `${CFG.publicUrl}/webhook/mp` } : {}),
    },
    order.id
  );
  const td = pay.point_of_interaction?.transaction_data || {};
  if (!td.qr_code) throw new Error("Mercado Pago não devolveu o código Pix");
  order.mpId = String(pay.id);
  order.qr = td.qr_code;
  order.qrBase64 = td.qr_code_base64 || "";
}

/** Confere o pagamento direto na API do Mercado Pago (nunca confia no que chega no webhook). */
async function syncPayment(mpId) {
  const pay = await mp("GET", `/v1/payments/${encodeURIComponent(mpId)}`);
  const order = orders[pay.external_reference];
  if (!order || order.mpId !== String(pay.id)) return null;
  if (pay.status === "approved") {
    if (money(pay.transaction_amount) !== order.amount) {
      log("VALOR DIFERENTE", order.id, pay.transaction_amount, order.amount);
      order.status = "divergent";
    } else if (order.status === "pending" || order.status === "expired") {
      order.status = "paid";
      order.paidAt = Date.now();
      order.discordPending = true;
      log("PAGO", order.id, order.tier, order.nick);
    }
  } else if (["cancelled", "rejected", "expired"].includes(pay.status) && order.status === "pending") {
    order.status = "expired";
  }
  saveOrders();
  discord.tick().catch((e) => log("DISCORD", e.message));
  return order;
}

// ---------------------------------------------------------------- entrega
const durToken = (days) => (days > 0 ? `${days}d` : "perm");
const commandFor = (o) => `scriptevent wc:vip give ${o.id} ${o.tier} ${durToken(o.days)} ${o.nick}`;

async function deliver(order) {
  if (CFG.delivery !== "ptero") return false;
  const res = await fetch(`${CFG.pteroUrl}/api/client/servers/${CFG.pteroServer}/command`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CFG.pteroKey}`,
      Accept: "Application/vnd.pterodactyl.v1+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ command: commandFor(order) }),
  });
  if (!res.ok) throw new Error(`painel respondeu ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return true;
}

let delivering = false;
async function deliveryTick() {
  if (delivering) return;
  delivering = true;
  try {
    for (const o of Object.values(orders)) {
      if (o.status !== "paid" || o.deliveredAt) continue;
      if (CFG.delivery !== "ptero") continue;
      if (o.nextTry && o.nextTry > Date.now()) continue;
      try {
        await deliver(o);
        o.deliveredAt = Date.now();
        o.lastError = "";
        log("ENTREGUE", o.id, o.nick);
      } catch (e) {
        o.tries = (o.tries || 0) + 1;
        o.lastError = String(e.message || e);
        o.nextTry = Date.now() + Math.min(300000, 10000 * 2 ** Math.min(o.tries, 5));
        log("FALHA NA ENTREGA", o.id, o.lastError);
      }
      saveOrders();
    }
    // Pix que ninguém pagou
    for (const o of Object.values(orders)) {
      if (o.status === "pending" && Date.now() - o.createdAt > (CFG.pixMinutes + 5) * 60000) {
        o.status = "expired";
        saveOrders();
      }
    }
  } finally {
    delivering = false;
  }
}

// ---------------------------------------------------------------- utilidades HTTP
const hits = new Map();
function limited(ip, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}
const clientIp = (req) => (CFG.trustProxy && req.headers["x-forwarded-for"]?.split(",")[0].trim()) || req.socket.remoteAddress || "?";

function send(res, code, body, headers = {}) {
  const isObj = typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(code, { "Content-Type": isObj ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
async function readJson(req, limit = 20000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("corpo grande demais"), { code: 413 });
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp" };
function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = path.normalize(path.join(ROOT, "public", rel));
  if (!file.startsWith(path.join(ROOT, "public") + path.sep)) return send(res, 403, "negado");
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "não encontrado");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": rel.startsWith("/img/") ? "public, max-age=86400" : "no-cache" });
    res.end(buf);
  });
}

function adminOk(req) {
  if (!CFG.adminPassword) return false;
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const pass = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(pass), b = Buffer.from(CFG.adminPassword);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const publicOrder = (o) => ({
  id: o.id, status: o.status, tier: o.tier, nick: o.nick, amount: o.amount, days: o.days,
  qr: o.status === "pending" ? o.qr : undefined,
  qrBase64: o.status === "pending" ? o.qrBase64 : undefined,
  delivered: !!o.deliveredAt, createdAt: o.createdAt, expiresAt: o.createdAt + CFG.pixMinutes * 60000,
});

// ---------------------------------------------------------------- rotas
const lastCheck = new Map();

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const ip = clientIp(req);

  if (req.method === "GET" && p === "/api/products") return send(res, 200, PRODUCTS);

  if (req.method === "POST" && p === "/api/order") {
    if (limited(ip, 8, 10 * 60000)) return send(res, 429, { error: "Muitas tentativas. Espere alguns minutos." });
    const b = await readJson(req);
    const tier = tierById.get(String(b.tier));
    const plan = tier?.plans.find((x) => x.days === Number(b.days));
    const nick = String(b.nick ?? "").trim().replace(/\s+/g, " ");
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!tier || !plan) return send(res, 400, { error: "Plano inválido." });
    if (!/^[A-Za-z0-9_ -]{3,20}$/.test(nick)) return send(res, 400, { error: "Nick inválido. Use 3 a 20 letras, números, espaço, _ ou -." });
    if (email && !/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) return send(res, 400, { error: "E-mail inválido (pode deixar em branco)." });
    if (!CFG.mpToken) return send(res, 503, { error: "Loja ainda não configurada." });
    const open = Object.values(orders).filter((o) => o.status === "pending" && o.nick.toLowerCase() === nick.toLowerCase()).length;
    if (open >= 3) return send(res, 429, { error: "Esse nick já tem Pix em aberto. Pague um deles ou espere expirar." });

    const order = {
      id: "ord" + crypto.randomBytes(8).toString("hex"), tier: tier.id, days: plan.days, nick,
      email: email || "cliente@wither.craft", amount: money(plan.price), status: "pending", createdAt: Date.now(),
    };
    try {
      await createPix(order, tier, plan.days ? `${plan.days} dias` : "permanente");
    } catch (e) {
      log("ERRO PIX", e.message);
      return send(res, 502, { error: "Não foi possível gerar o Pix agora. Tente de novo em instantes." });
    }
    orders[order.id] = order;
    saveOrders();
    log("PEDIDO", order.id, order.tier, order.days, order.nick, order.amount);
    return send(res, 200, publicOrder(order));
  }

  let m;
  if (req.method === "GET" && (m = /^\/api\/order\/(ord[a-f0-9]{16})$/.exec(p))) {
    const o = orders[m[1]];
    if (!o) return send(res, 404, { error: "Pedido não encontrado." });
    // confere no Mercado Pago a cada 5s enquanto estiver pendente (não depende só do webhook)
    if (o.status === "pending" && o.mpId && Date.now() - (lastCheck.get(o.id) || 0) > 5000) {
      lastCheck.set(o.id, Date.now());
      try { await syncPayment(o.mpId); } catch (e) { log("sync", e.message); }
      deliveryTick().catch(() => {});
    }
    return send(res, 200, publicOrder(o));
  }

  if (p === "/webhook/mp" && (req.method === "POST" || req.method === "GET")) {
    let id = url.searchParams.get("data.id") || url.searchParams.get("id");
    let type = url.searchParams.get("type") || url.searchParams.get("topic");
    if (req.method === "POST") {
      try {
        const b = await readJson(req);
        id = b?.data?.id ?? id;
        type = b?.type ?? type;
      } catch {}
    }
    send(res, 200, "ok");
    if (id && (!type || type === "payment")) {
      try { await syncPayment(String(id)); deliveryTick().catch(() => {}); } catch (e) { log("webhook", e.message); }
    }
    return;
  }

  // ---- admin
  if (p === "/admin" || p.startsWith("/admin/")) {
    if (!adminOk(req)) return send(res, 401, "Senha necessária", { "WWW-Authenticate": 'Basic realm="Loja"' });
    if (p === "/admin") return serveStatic(req, res, "/admin.html");
    if (req.method === "POST" && p === "/admin/api/discord/test") {
      // Requer JSON e cabeçalho próprio para impedir envio por formulários de outros sites.
      if (req.headers["x-wither-admin"] !== "1" || req.headers["content-type"] !== "application/json" || (req.headers.origin && ![CFG.publicUrl, `http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin))) {
        return send(res, 403, { error: "Abra o teste pelo painel da própria loja." });
      }
      if (limited(`discord-test:${ip}`, 3, 60000)) return send(res, 429, { error: "Aguarde um minuto antes de testar novamente." });
      try {
        await discord.test();
        return send(res, 200, { ok: true, message: "Mensagem de teste enviada! Confira o canal do Discord." });
      } catch (e) {
        return send(res, CFG.discordWebhook ? 502 : 503, { error: e.message });
      }
    }
    if (req.method === "GET" && p === "/admin/api/orders") {
      const list = Object.values(orders).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200)
        .map((o) => ({ id: o.id, tier: o.tier, days: o.days, nick: o.nick, amount: o.amount, status: o.status, createdAt: o.createdAt, paidAt: o.paidAt, deliveredAt: o.deliveredAt, lastError: o.lastError, command: commandFor(o), discordSentAt: o.discordSentAt, discordPending: o.discordPending, discordError: o.discordError }));
      return send(res, 200, { mode: CFG.delivery, discordConfigured: !!CFG.discordWebhook, orders: list });
    }
    if (req.method === "POST" && (m = /^\/admin\/api\/orders\/(ord[a-f0-9]{16})\/(resend|delivered)$/.exec(p))) {
      const o = orders[m[1]];
      if (!o) return send(res, 404, { error: "não existe" });
      if (m[2] === "resend") { o.deliveredAt = 0; o.nextTry = 0; o.tries = 0; deliveryTick().catch(() => {}); }
      else o.deliveredAt = Date.now();
      saveOrders();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, "não encontrado");
  }

  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, p);
  send(res, 404, "não encontrado");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    log("ERRO", req.method, req.url, e.message);
    if (!res.headersSent) send(res, e.code === 413 ? 413 : 500, { error: e.code === 413 ? "Pedido grande demais." : "Erro interno." });
  });
});
server.listen(CFG.port, () => {
  log(`Loja no ar: http://localhost:${CFG.port}  (entrega: ${CFG.delivery})`);
  if (!CFG.mpToken) log("AVISO: MP_ACCESS_TOKEN vazio, a loja não consegue gerar Pix.");
  if (!CFG.adminPassword) log("AVISO: ADMIN_PASSWORD vazio, o /admin fica bloqueado.");
  if (CFG.delivery === "ptero" && !(CFG.pteroUrl && CFG.pteroKey && CFG.pteroServer)) log("AVISO: faltam PTERO_URL / PTERO_API_KEY / PTERO_SERVER_ID, a entrega automática não vai funcionar.");
});
setInterval(() => deliveryTick().catch((e) => log("tick", e.message)), 10000);
setInterval(() => discord.tick().catch((e) => log("DISCORD", e.message)), 10000);
discord.tick().catch((e) => log("DISCORD", e.message));
