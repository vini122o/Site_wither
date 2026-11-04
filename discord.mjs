// Executado somente no servidor. A URL secreta nunca é enviada ao navegador.
export function createDiscord({ webhook, orders, saveOrders, tierById, log, fetcher = fetch, now = Date.now }) {
  let busy = false;
  let blockedUntil = 0;
  const brl = (value) => Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  async function send(embed) {
    if (!webhook) throw new Error("Configure DISCORD_WEBHOOK_URL no .env e reinicie a loja.");
    let url;
    try {
      url = new URL(webhook);
      if (url.protocol !== "https:" || url.hostname !== "discord.com" || url.port || url.username || url.password || !/^\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error();
    } catch { throw new Error("DISCORD_WEBHOOK_URL inválido. Use a URL do webhook do Discord."); }
    if (now() < blockedUntil) throw new Error("Discord pediu uma pausa. Aguarde alguns instantes e tente novamente.");
    url.searchParams.set("wait", "true");
    let response;
    let data;
    try {
      response = await fetcher(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "WitherCraft • Loja", allowed_mentions: { parse: [] }, embeds: [embed] }),
      });
      data = await response.json().catch(() => ({}));
    } catch { throw new Error("Não foi possível confirmar o envio ao Discord. Verifique a conexão e tente novamente."); }
    if (response.status === 429) {
      const seconds = Number(data.retry_after);
      blockedUntil = now() + (Number.isFinite(seconds) && seconds > 0 ? Math.max(1, seconds) : 30) * 1000;
      throw new Error("Limite de mensagens do Discord atingido. Aguarde e tente novamente.");
    }
    if (!response.ok) {
      if ([401, 403, 404].includes(response.status)) throw new Error("Webhook indisponível ou sem permissão. Confira DISCORD_WEBHOOK_URL e reinicie a loja.");
      throw new Error(`Discord respondeu HTTP ${response.status}. Tente novamente em instantes.`);
    }
    if (!data.id) throw new Error("Discord não confirmou a criação da mensagem. Tente novamente.");
    return data.id;
  }

  async function test() {
    return send({
      title: "Teste do webhook • WitherCraft", color: 0x9b6dff,
      description: "Conexão funcionando! Os avisos de compras confirmadas serão enviados neste canal.\n\nEsta é uma mensagem de teste: nenhum pagamento ou VIP foi criado.",
      timestamp: new Date(now()).toISOString(),
    });
  }

  async function tick() {
    if (busy || !webhook || now() < blockedUntil) return;
    busy = true;
    try {
      for (const o of Object.values(orders)) {
        // Apenas pagamentos confirmados após a ativação desta integração entram na fila.
        if (o.status !== "paid" || !o.discordPending || o.discordSentAt || o.discordNextTry > now()) continue;
        if (now() < blockedUntil) break;
        try {
          o.discordMessageId = await send({
            title: "Compra confirmada • WitherCraft", color: 0x57f287,
            description: "Pagamento Pix aprovado e conferido no Mercado Pago.",
            fields: [
              { name: "Jogador", value: o.nick, inline: true },
              { name: "VIP", value: String(tierById.get(o.tier)?.name || o.tier).slice(0, 1024), inline: true },
              { name: "Duração", value: o.days ? `${o.days} dias` : "Permanente", inline: true },
              { name: "Valor", value: brl(o.amount), inline: true },
              { name: "Pedido", value: o.id },
            ],
            footer: { text: "Acompanhe a entrega do VIP no painel da loja." },
            timestamp: new Date(o.paidAt).toISOString(),
          });
          o.discordSentAt = now();
          o.discordPending = false;
          o.discordError = "";
          o.discordNextTry = 0;
          log("DISCORD ENVIADO", o.id);
        } catch (e) {
          o.discordTries = (o.discordTries || 0) + 1;
          o.discordError = e.message;
          o.discordNextTry = Math.max(blockedUntil, now() + Math.min(300000, 10000 * 2 ** Math.min(o.discordTries, 5)));
          log("FALHA DISCORD", o.id, o.discordError);
        }
        saveOrders();
      }
    } finally { busy = false; }
  }
  return { test, tick };
}
