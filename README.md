# Loja VIP do WitherCraft

Site onde o jogador escolhe o VIP, vê o kit, paga com **Pix (Mercado Pago)** e recebe o VIP no jogo sozinho.
Não precisa instalar nada além do Node 18+: `node server.mjs`.

## Como a entrega funciona
1. A pessoa paga o Pix. O Mercado Pago avisa a loja (e a loja também confere sozinha a cada poucos segundos).
2. A loja confere o pagamento **direto na API do Mercado Pago** (valor e pedido) e só então libera.
3. A loja manda este comando ao console do servidor pelo painel:
   `scriptevent wc:vip give <pedido> <vip> <tempo> <nick>`
4. O addon (módulo VIP, versão fix68 ou mais nova) ativa o VIP. Só o console consegue usar esse comando, e o mesmo pedido nunca entrega duas vezes (se a loja reenviar, nada duplica).

## Passo a passo
1. **Addon**: instale o `.mcaddon` fix68 no servidor e crie os VIPs no jogo com os mesmos nomes de `products.json`:
   segure o kit e digite `!vip definir kit vip 7d`, depois `plus` e `ultra`.
2. **Preços e textos**: edite `products.json` (os preços que vêm são de exemplo). `days: 0` = permanente. O `id` de cada VIP tem que ser igual ao nome usado no jogo.
3. **Mercado Pago**: crie o app em https://www.mercadopago.com.br/developers, copie o Access Token de produção para `MP_ACCESS_TOKEN`. Teste antes com as credenciais de teste.
4. **Hospedagem da loja**: ela precisa ficar online 24h com endereço https (Render, Railway, uma VPS...). Copie esta pasta, preencha o `.env` incluído (ou use o `.env.example` se começar do zero) e rode `node server.mjs`. Em `PUBLIC_URL` vai o endereço final. Os pedidos ficam em `data/orders.json` (faça backup).
5. **Painel do servidor** (entrega automática): se o seu host usa o painel Pterodactyl, gere uma chave em *Conta > API Credentials* e preencha `PTERO_URL`, `PTERO_API_KEY` e `PTERO_SERVER_ID` (o código curto do servidor que aparece no endereço do painel).
   **Se o seu host não tiver API**, use `DELIVERY_MODE=manual`: a loja confirma o Pix e mostra no `/admin` o comando pronto de cada pedido, e você só cola no console (um clique para copiar). Mesmo assim o jogador vê "pagamento confirmado".
6. Abra `https://sua-loja/admin` (senha do `.env`) para ver pedidos, copiar comandos, reenviar ou marcar como entregue.

## Segurança embutida
- O preço sempre vem do `products.json` no servidor, nunca do navegador.
- Pagamento só vale depois de conferido na API do Mercado Pago, com valor igual ao do pedido.
- O nick só aceita letras, números, espaço, `_` e `-` (impede injetar comandos).
- Limite de pedidos por IP e por nick.
- Se o servidor de Minecraft estiver fora do ar, a loja tenta entregar de novo sozinha.

## Discord: já configurado neste pacote
O `.env` incluído já contém o webhook informado e uma senha aleatória em `ADMIN_PASSWORD`.
Se você já tem uma instalação configurada, mantenha seu `.env` e copie somente a linha `DISCORD_WEBHOOK_URL` do novo pacote. Mantenha também a pasta `data` com os pedidos.

1. Extraia o ZIP inteiro. Mantenha `server.mjs`, `discord.mjs`, `.env` e a pasta `public` na mesma pasta.
2. Rode `node server.mjs` (ou `npm start`). Não abra apenas o HTML: o envio usa o servidor Node.
3. Abra `http://localhost:3000/admin` no PC ou `/admin` no endereço da loja hospedada.
4. Use qualquer usuário e a senha que está em `ADMIN_PASSWORD` no `.env`.
5. Clique em **Testar Discord**. A tela mostra o resultado real do envio. O teste funciona sem configurar Mercado Pago ou entrega de VIP.

A mensagem de teste é identificada como teste e não cria pedido, pagamento ou VIP. Nas compras, o aviso sai apenas após a confirmação do Pix na API do Mercado Pago, com jogador, VIP, duração, valor e número do pedido. Gerar um Pix pendente não envia aviso. O teste aceita até três tentativas por minuto.

O painel mostra o estado do aviso de cada pedido. Falhas são salvas e tentadas novamente, mesmo após reiniciar a loja; pedidos antigos anteriores à integração não são anunciados retroativamente. Falhas no Discord não impedem a confirmação do pagamento nem a entrega. A confirmação de envio fica gravada para evitar repetições normais. Se o Discord receber uma mensagem, mas a conexão cair antes da resposta, uma nova tentativa pode repetir o aviso; confira o número do pedido.

Mantenha `.env` fora de pastas públicas e repositórios. A URL do webhook fica somente no servidor. Hospedagens que configuram variáveis pelo painel devem receber `DISCORD_WEBHOOK_URL` e `ADMIN_PASSWORD` por lá. Reinicie a loja após alterar a configuração.

Para verificar os testes automatizados sem enviar mensagens reais: `node --test test/discord.test.mjs`.
