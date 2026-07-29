# TikTok LIVE → Roblox Bridge (Node.js + TypeScript)

Servidor intermediário que escuta os eventos de uma live do TikTok (presentes,
curtidas e comentários) e os disponibiliza para um jogo no Roblox via polling HTTP.

```
[TikTok LIVE] ──▶ [Servidor Node.js (este projeto)] ◀── GET /api/events ── [Roblox (Luau)]
```

## Requisitos

- Node.js **18+**
- Uma conta do TikTok que esteja **ao vivo** no momento do teste
  (a conexão só é estabelecida enquanto a pessoa está transmitindo).

## Instalação

```bash
npm install
cp .env.example .env
# edite o .env e preencha TIKTOK_USERNAME e API_SECRET_KEY
```

Gere uma chave secreta forte:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Como rodar

Desenvolvimento (recarrega ao salvar, roda o `.ts` direto com `tsx`):

```bash
npm run dev
```

Produção (compila para `dist/` e roda com `node`):

```bash
npm run build
npm start
```

Só checar a tipagem, sem gerar arquivos:

```bash
npm run typecheck
```

## Endpoints

### `GET /health` (público)

Sem autenticação. Útil para monitorar o processo.

```json
{
  "status": "ok",
  "username": "nomedousuario",
  "liveConnected": true,
  "queued": 3,
  "uptimeSeconds": 142
}
```

### `GET /api/events` (protegido)

Exige o header `x-api-key` igual ao `API_SECRET_KEY` do `.env`.
Retorna os eventos acumulados **e limpa a fila na hora** — cada evento é
entregue uma única vez.

Requisição:

```
GET /api/events
x-api-key: SUA_CHAVE
```

Resposta:

```json
{
  "count": 2,
  "serverTime": "2026-07-28T12:00:00.000Z",
  "events": [
    {
      "id": 41,
      "type": "gift",
      "timestamp": "2026-07-28T11:59:59.500Z",
      "user": { "uniqueId": "fulano", "nickname": "Fulano", "userId": "123" },
      "giftId": 5655,
      "giftName": "Rose",
      "repeatCount": 3,
      "diamondCount": 1
    },
    {
      "id": 42,
      "type": "chat",
      "timestamp": "2026-07-28T12:00:00.100Z",
      "user": { "uniqueId": "ciclano", "nickname": "Ciclano", "userId": "456" },
      "comment": "vamooo!"
    }
  ]
}
```

Formatos por `type`:

- `gift`  → `giftId`, `giftName`, `repeatCount`, `diamondCount`
- `like`  → `likeCount`, `totalLikeCount`
- `chat`  → `comment`

Sem `x-api-key` válido: `401 { "error": "Unauthorized" }`.

## Detalhes de implementação

- **Reconexão automática** com backoff exponencial + jitter (teto configurável).
  Se o usuário não estiver ao vivo, o servidor segue tentando periodicamente.
- **Dedup de presentes em streak**: presentes "streakable" (`giftType === 1`)
  só entram na fila quando a streak termina (`repeatEnd`), evitando duplicatas.
- **Fila com teto** (`MAX_QUEUE_SIZE`): se o Roblox parar de fazer polling, os
  eventos mais antigos são descartados para não estourar a memória.
- **Comparação de chave em tempo constante** (`crypto.timingSafeEqual`).

## Sobre limites de taxa (EulerStream)

A `tiktok-live-connector` v2 usa um serviço de assinatura (EulerStream) para
estabelecer a conexão. O tier gratuito tem limites de requisição. Para uso mais
intenso/estável, crie uma chave em https://www.eulerstream.com e defina
`SIGN_API_KEY` no `.env`.

## Lado do Roblox (resumo)

No Roblox, use `HttpService` em um `Script` no lado do servidor para fazer
polling (ex.: a cada 1–2s) enviando o header `x-api-key`, e reaja a cada evento
retornado. Lembre de habilitar *"Allow HTTP Requests"* nas configurações do jogo.

## Aviso

Esta biblioteca acessa dados da live de forma não-oficial. Respeite os Termos de
Serviço do TikTok e as regras da plataforma Roblox no seu uso.
