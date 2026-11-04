"use strict";

const $ = (s, r = document) => r.querySelector(s);
const brl = (n) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};
const planLabel = (p) => (p.days ? `${p.days} dias` : "Permanente");
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

let products = null;
let tier = null;
let planDays = null;
let poll = null;
let currentOrder = null;

const dlg = $("#checkout");
const steps = [...dlg.querySelectorAll(".co-step")];
const showStep = (name) => steps.forEach((s) => (s.hidden = s.dataset.step !== name));

function tint(t) {
  const shop = $("#loja");
  shop.style.setProperty("--tier", t.color);
  shop.style.setProperty("--on-tier", "#160d00");
  dlg.style.setProperty("--tier", t.color);
}

function renderTabs() {
  const tabs = $("#tabs");
  tabs.replaceChildren(
    ...products.tiers.map((t) => {
      const b = el("button", { className: "tab", type: "button", role: "tab", textContent: t.name });
      b.style.setProperty("--c", t.color);
      b.setAttribute("aria-selected", String(t === tier));
      b.addEventListener("click", () => select(t));
      return b;
    })
  );
}

function renderChest() {
  const chest = $("#chest");
  chest.replaceChildren(
    ...tier.images.map((i) => {
      const img = el("img", { src: i.src, alt: i.alt, loading: "lazy" });
      return el("figure", {}, img);
    })
  );
}

function renderBuy() {
  const buy = $("#buy");
  const plans = el("fieldset", { className: "plans" }, el("legend", { className: "sr", textContent: "Tempo de VIP", hidden: true }));
  for (const p of tier.plans) {
    const input = el("input", { type: "radio", name: "plan", value: String(p.days), checked: p.days === planDays });
    input.addEventListener("change", () => { planDays = p.days; });
    const label = el(
      "label",
      { className: "plan" },
      input,
      el("span", {}, planLabel(p), p.days ? el("small", { textContent: "renova somando o tempo" }) : el("small", { textContent: "pague uma vez e use para sempre" })),
      el("strong", { textContent: brl(p.price) })
    );
    plans.append(label);
  }
  const buy_btn = el("button", { className: "btn", type: "button", textContent: `Comprar ${tier.name}` });
  buy_btn.addEventListener("click", openCheckout);
  buy.replaceChildren(
    el("h2", { textContent: tier.name }),
    el("p", { className: "tagline", textContent: tier.tagline }),
    el("ul", { className: "perks" }, ...tier.perks.map((t) => el("li", { textContent: t }))),
    plans,
    buy_btn
  );
}

function select(t) {
  tier = t;
  planDays = t.plans[0].days;
  tint(t);
  renderTabs();
  renderChest();
  renderBuy();
  history.replaceState(null, "", `#${t.id}`);
}

// ---------------------------------------------------------------- checkout
const currentPlan = () => tier.plans.find((p) => p.days === planDays);
const summary = (t, p, price) => {
  const s = el("span", {}, "VIP ", el("b", { textContent: t.name }), ` · ${planLabel(p)} · ${brl(price ?? p.price)}`);
  return s;
};

function openCheckout() {
  const p = currentPlan();
  $("#co-summary").replaceChildren(summary(tier, p));
  $("#co-error").hidden = true;
  showStep("form");
  const saved = store.get("wc_nick");
  if (saved) $("#co-form").nick.value = saved;
  if (!dlg.open) dlg.showModal();
  $("#co-form").nick.focus();
}

$("#co-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $("#co-error");
  const btn = $("#co-submit");
  err.hidden = true;
  const nick = f.nick.value.trim();
  if (!/^[A-Za-z0-9_ -]{3,20}$/.test(nick)) {
    err.textContent = "Digite seu nick do jogo (3 a 20 letras, números, espaço, _ ou -).";
    err.hidden = false;
    return;
  }
  btn.disabled = true;
  btn.textContent = "Gerando Pix…";
  try {
    const res = await fetch("/api/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier: tier.id, days: planDays, nick, email: f.email.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Erro ao gerar o Pix.");
    store.set("wc_nick", nick);
    store.set("wc_order", data.id);
    showOrder(data);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Gerar Pix";
  }
});

function tierOf(id) { return products.tiers.find((t) => t.id === id); }

function showOrder(o) {
  currentOrder = o;
  const t = tierOf(o.tier);
  const plan = t?.plans.find((p) => p.days === o.days) || { days: o.days, price: o.amount };
  if (t) dlg.style.setProperty("--tier", t.color);

  if (o.status === "pending") {
    $("#co-summary2").replaceChildren(summary(t, plan, o.amount), ` · para ${o.nick}`);
    const qr = $("#co-qr");
    if (o.qrBase64 && /^[A-Za-z0-9+/=]+$/.test(o.qrBase64)) { qr.src = "data:image/png;base64," + o.qrBase64; qr.hidden = false; } else qr.hidden = true;
    $("#co-code").value = o.qr || "";
    $("#co-copy").textContent = "Copiar código";
    showStep("pix");
    startPolling(o.id);
  } else if (o.status === "paid") {
    stopPolling();
    $("#co-order-id").textContent = o.id;
    if (o.delivered) {
      $("#co-paid-title").textContent = "VIP ativado";
      $("#co-paid-text").replaceChildren(`Pronto, ${o.nick}! Entre no servidor e digite `, el("code", { textContent: "!vip kit" }), " para pegar seu kit.");
      store.del("wc_order");
    } else {
      $("#co-paid-title").textContent = "Pagamento confirmado";
      $("#co-paid-text").textContent = "Estamos ativando seu VIP no servidor. Isso leva alguns segundos, não feche esta janela.";
      startPolling(o.id);
    }
    showStep("paid");
  } else if (o.status === "expired") {
    stopPolling();
    store.del("wc_order");
    showStep("expired");
  } else {
    stopPolling();
    $("#co-order-id").textContent = o.id;
    $("#co-paid-title").textContent = "Pedido em análise";
    $("#co-paid-text").textContent = "O valor pago não bate com o pedido. Chame a staff no servidor com o código abaixo.";
    showStep("paid");
  }
}

function startPolling(id) {
  stopPolling();
  poll = setInterval(async () => {
    try {
      const res = await fetch(`/api/order/${id}`);
      if (!res.ok) return;
      const o = await res.json();
      if (o.status !== currentOrder?.status || o.delivered !== currentOrder?.delivered) showOrder(o);
      else currentOrder = o;
    } catch {}
  }, 3500);
}
function stopPolling() { clearInterval(poll); poll = null; }

$("#co-copy").addEventListener("click", async () => {
  const input = $("#co-code");
  try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand("copy"); }
  $("#co-copy").textContent = "Código copiado";
});
$("#co-done").addEventListener("click", () => dlg.close());
$("#co-retry").addEventListener("click", openCheckout);
dlg.addEventListener("close", () => {
  // fechar a janela não cancela o Pix; só para de consultar
  if (currentOrder?.status !== "pending" && !(currentOrder?.status === "paid" && !currentOrder.delivered)) stopPolling();
});

// ---------------------------------------------------------------- início
(async function init() {
  try {
    products = await (await fetch("/api/products")).json();
  } catch {
    $("#chest").textContent = "Não foi possível carregar a loja. Recarregue a página.";
    return;
  }
  const wanted = location.hash.slice(1);
  select(tierOf(wanted) || products.tiers[products.tiers.length - 1]);

  // retoma um pedido em andamento se a pessoa recarregou a página
  const last = store.get("wc_order");
  if (last && /^ord[a-f0-9]{16}$/.test(last)) {
    try {
      const res = await fetch(`/api/order/${last}`);
      if (res.ok) {
        const o = await res.json();
        if (o.status === "pending" || (o.status === "paid" && !o.delivered)) { dlg.showModal(); showOrder(o); }
        else store.del("wc_order");
      } else store.del("wc_order");
    } catch {}
  }
})();
