import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiscord } from "../discord.mjs";

const webhook = "https://discord.com/api/webhooks/123456/test-token";
const paid = (id = "ord123") => ({ id, status: "paid", discordPending: true, nick: "Player_01", tier: "vip", days: 30, amount: 12.5, paidAt: Date.now() });
function setup(orders = {}, fetcher) {
  const calls = [];
  let time = Date.now();
  const cfg = { webhook, orders, tierById: new Map(), saveOrders() {}, log() {}, now: () => time,
    fetcher: fetcher || (async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return Response.json({ id: "message-1" }); }) };
  return { cfg, calls, advance: (ms) => time += ms, discord: createDiscord(cfg) };
}
test("teste é identificado, exige confirmação e não cria pedido", async () => {
  const orders = {};
  const { discord, calls } = setup(orders);
  await discord.test();
  assert.deepEqual(orders, {});
  assert.equal(calls[0].url.searchParams.get("wait"), "true");
  assert.match(calls[0].body.embeds[0].title, /Teste/);
  assert.deepEqual(calls[0].body.allowed_mentions.parse, []);
});
test("apenas pago na fila envia; concorrência e reinício não repetem envio confirmado", async () => {
  const orders = { paid: paid(), pending: { ...paid(), status: "pending" }, old: { ...paid(), discordPending: false }, divergent: { ...paid(), status: "divergent" } };
  const { discord, cfg, calls } = setup(orders);
  await Promise.all([discord.tick(), discord.tick(), discord.tick()]);
  await createDiscord(cfg).tick();
  assert.equal(calls.length, 1);
  assert.ok(orders.paid.discordSentAt);
  assert.equal(orders.paid.discordPending, false);
  assert.equal(calls[0].body.embeds[0].fields.find(f => f.name === "Jogador").value, "Player_01");
});
test("falha preserva pagamento e fila, com nova tentativa após reinício", async () => {
  const orders = { a: paid() };
  const { discord, cfg, advance } = setup(orders, async () => Response.json({}, { status: 500 }));
  await discord.tick();
  assert.equal(orders.a.status, "paid");
  assert.ok(orders.a.discordPending);
  assert.match(orders.a.discordError, /500/);
  let attempts = 0;
  const restarted = createDiscord({ ...cfg, orders: JSON.parse(JSON.stringify(orders)), fetcher: async () => { attempts++; return Response.json({ id: "ok" }); } });
  await restarted.tick();
  assert.equal(attempts, 0);
  advance(300001);
  await restarted.tick();
  assert.equal(attempts, 1);
});
test("limite do Discord pausa fila e testes", async () => {
  let attempts = 0;
  const { discord } = setup({ a: paid(), b: paid("ord456") }, async () => { attempts++; return Response.json({ retry_after: 60 }, { status: 429 }); });
  await discord.tick();
  assert.equal(attempts, 1);
  await assert.rejects(discord.test(), /pausa/);
});
test("URL ausente, inválida e erros de rede não vazam segredo", async () => {
  const { cfg } = setup();
  await assert.rejects(createDiscord({ ...cfg, webhook: "" }).test(), /Configure/);
  await assert.rejects(createDiscord({ ...cfg, webhook: "https://example.com/api/webhooks/1/secret" }).test(), /inválido/);
  await assert.rejects(createDiscord({ ...cfg, fetcher: async () => { throw new Error(webhook); } }).test(), e => !e.message.includes("test-token"));
  await assert.rejects(createDiscord({ ...cfg, fetcher: async () => Response.json({}) }).test(), /não confirmou/);
});
