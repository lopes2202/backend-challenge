# Backend Challenge — Jungle Gaming (Wagering & Wallet Ledger)

Serviço financeiro para processamento de transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`) recebidas de múltiplos provedores de jogos via **HTTP REST** e **AWS SQS FIFO**.

---

## 1. Visão Geral

O projeto foi desenvolvido para operar em cenário concorrente com múltiplas instâncias conectadas ao mesmo banco, garantindo que mensagens duplicadas, entregas fora de ordem ou picos de requisições simultâneas na mesma carteira nunca corrompam o saldo do jogador.

Pontos centrais da implementação:

- **Precisão monetária (sem `number`):** Nenhum valor financeiro usa `number` ou ponto flutuante. Os valores trafegam como strings decimais (`^\d+\.\d{2}$`), são calculados no Value Object `Money` (`src/domain/models/money.ts`) com `decimal.js` e salvos como `NUMERIC(18, 2)` no PostgreSQL (com `sequence` do ledger em `BIGSERIAL` / `bigint`).
- **Concorrência entre múltiplas instâncias:** Aplicação *stateless* usando bloqueio pessimista por carteira (`SELECT ... FOR UPDATE`) no PostgreSQL. Apostas simultâneas do mesmo jogador entram em fila no banco sem gerar *race conditions*, enquanto carteiras de jogadores diferentes rodam em paralelo.
- **Idempotência persistente:** Deduplicação no banco via `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`, validada por um hash `SHA-256` do JSON canônico (`canonicalJsonHash`). Reenvios idênticos devolvem o resultado original (`idempotentReplay: true`); se o payload mudar para a mesma chave, a API rejeita com `409 Conflict`.
- **Consistência entre saldo e Ledger:** Toda mudança de saldo grava, na mesma transação SQL, uma entrada sequencial em `wallet_ledger_entries` (`balance_before`, `amount`, `direction`, `balance_after`). A tabela é *append-only*, protegida por constraint `CHECK` da equação contábil e por triggers PL/pgSQL que bloqueiam `UPDATE`, `DELETE` e `TRUNCATE`.
- **Processamento assíncrono e recuperação de falhas:** Eventos nunca são enviados ao SQS antes do commit no banco (*Transactional Outbox*). O consumidor SQS deduplica entregas pela tabela `inbox_messages` (só enviando ACK após o commit), move mensagens inválidas para a DLQ e reprocessa reversões que chegaram fora de ordem (`PENDING_REFERENCE`) com *exponential backoff* e TTL.

---

## 2. Decisões Técnicas e Fluxo Principal

### Organização do Código

A principal decisão na estruturação do projeto foi separar responsabilidades em camadas claras (**Clean Architecture / Ports & Adapters**), deixando o domínio e os casos de uso (`src/domain/` e `src/application/`) livres de dependências de NestJS, TypeORM ou AWS SDK. Isso tornou o código mais simples de navegar, testar isoladamente e explicar:

1. **Domínio (`src/domain/`):** Guarda os modelos de negócio (`Wallet`, `Money`, `WagerTransaction`, `WalletLedgerEntry`), as regras de estorno (`reversal-policy.ts`) e os erros de domínio.
2. **Aplicação (`src/application/`):** Coordena os casos de uso através do contrato `UnitOfWorkPort`. O mesmo caso de uso (`ProcessWagerTransactionUseCase`) atende tanto as chamadas HTTP quanto o consumidor SQS.
3. **Infraestrutura e HTTP (`src/infra/` e `src/presentation/`):** Implementam o controle transacional com SQL explícito sobre o `QueryRunner` do TypeORM (`PostgresUnitOfWork`), os workers em background (`workers.ts`) e os controllers REST.

### Fluxo Principal

1. **Criação da Carteira (`POST /wallets`):**
   - Abre transação via `PostgresUnitOfWork`, valida unicidade de `(playerId, currency)` e cria a carteira com `version = 1`.
   - Se houver saldo inicial (`initialBalance > 0`), registra na mesma transação uma operação `OPENING` (`PROCESSED`), o lançamento inicial `CREDIT` no ledger e os eventos correspondentes na tabela `outbox_messages`.
2. **Entrada da Transação (HTTP ou SQS):**
   - A requisição chega no endpoint `POST /wagering/transactions` (com header `Idempotency-Key`) ou pela fila `wager-transactions.fifo`.
   - O parser valida o formato dos dados e gera o `payloadHash` (`SHA-256`) ordenando as chaves do JSON recursivamente.
3. **Lock da Carteira e Checagem de Idempotência:**
   - Inicia transação `READ COMMITTED` e aplica `SELECT * FROM wallets WHERE id = $1 FOR UPDATE`.
   - No fluxo SQS, grava na tabela `inbox_messages` (`ON CONFLICT DO NOTHING`) para evitar reprocessamento em caso de redelivery.
   - Verifica se a `idempotency_key` ou `(provider_id, external_transaction_id)` já existe. Se existir com o mesmo hash, retorna replay (`idempotentReplay: true`); se o hash for diferente, retorna `409 Conflict`.
4. **Execução das Regras de Jogo (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`):**
   - **`BET`:** Confere saldo (`canDebit`). Com saldo suficiente, debita e incrementa `version`; sem saldo, grava a transação como `REJECTED` (`INSUFFICIENT_FUNDS`) sem mexer no saldo nem no ledger.
   - **`WIN`:** Credita o prêmio na carteira e incrementa `version`.
   - **`LOSS`:** Registra o resultado da rodada como `PROCESSED` (`amount = 0.00`) sem alterar saldo ou ledger.
   - **`REFUND` / `ROLLBACK`:** Busca a transação original. Se ela ainda não chegou, salva como `PENDING_REFERENCE` (`202 Accepted`) para o worker tentar novamente depois. Se já chegou e é válida, aplica o estorno (`CREDIT` para `BET`, `DEBIT` para `WIN`/`REFUND`), bloqueando duplas reversões (`REFERENCE_ALREADY_REVERSED`) ou estornos que deixariam a carteira negativa (`NEGATIVE_BALANCE_ON_REVERSAL`).
5. **Commit e Workers Assíncronos:**
   - Salva carteira, transação, entrada do ledger e eventos da outbox na mesma transação e executa o `COMMIT`.
   - Em segundo plano, o `OutboxPublisherWorker` lê `outbox_messages` com `FOR UPDATE SKIP LOCKED` e publica na fila `wager-events.fifo`, enquanto o `PendingReferenceRetryWorker` reprocessa transações `PENDING_REFERENCE` até resolverem ou expirarem por TTL.

### Resumo das Decisões Técnicas

| Decisão | Por que foi adotada | Arquivo principal |
|---|---|---|
| **`decimal.js` + `NUMERIC(18, 2)`** | Evita erros de precisão de ponto flutuante e bloqueia `number` em runtime. | `src/domain/models/money.ts` |
| **SQL explícito no `PostgresUnitOfWork`** | Dá controle direto sobre `SELECT ... FOR UPDATE`, `SKIP LOCKED`, `ON CONFLICT` e nível de isolamento. | `src/infra/database/postgres-uow.ts` |
| **Lock pessimista por carteira (`FOR UPDATE`)** | Garante fila única de escrita para uma mesma carteira sem travar o restante do banco. | `src/infra/database/postgres-uow.ts` |
| **Hash SHA-256 de JSON Canônico** | Faz com que a ordem das propriedades no JSON não afete o cálculo de idempotência. | `src/application/utils/canonical-json-hash.ts` |
| **Triggers PL/pgSQL + `CHECK` no banco** | Garante no próprio PostgreSQL que o ledger nunca sofra `UPDATE`, `DELETE` ou `TRUNCATE`. | `src/infra/database/migrations/1730000000000-initial-schema.ts` |
| **Índice Único Parcial (`uq_single_processed_reversal`)** | Trava no banco qualquer tentativa concorrente de reverter a mesma transação duas vezes. | `src/infra/database/migrations/1730000000000-initial-schema.ts` |
| **Reconciliação com `REPEATABLE READ READ ONLY`** | Compara o saldo da carteira com a soma do ledger no mesmo snapshot, sem bloquear apostas em andamento. | `src/application/use-cases/reconcile-wallet.use-case.ts` |

---

## 3. Estrutura de Pastas e Módulos

```text
.
├── docker/
│   ├── localstack/
│   │   └── init-sqs.sh
│   └── postgres/
│       └── init-test-db.sql
├── src/
│   ├── app.module.ts
│   ├── main.ts
│   ├── domain/
│   │   ├── errors/
│   │   │   ├── domain-errors.ts
│   │   │   └── failure-code.ts
│   │   ├── events/
│   │   │   └── wager-events.ts
│   │   ├── models/
│   │   │   ├── currency.ts
│   │   │   ├── inbox-message.ts
│   │   │   ├── money.ts
│   │   │   ├── outbox-message.ts
│   │   │   ├── wager-transaction.ts
│   │   │   ├── wallet-ledger-entry.ts
│   │   │   └── wallet.ts
│   │   └── services/
│   │       ├── backoff.ts
│   │       └── reversal-policy.ts
│   ├── application/
│   │   ├── dto/
│   │   │   ├── views.ts
│   │   │   └── wager-transaction-command.ts
│   │   ├── ports/
│   │   │   └── index.ts
│   │   ├── use-cases/
│   │   │   ├── create-wallet.use-case.ts
│   │   │   ├── process-wager-transaction.use-case.ts
│   │   │   ├── queries.use-case.ts
│   │   │   └── reconcile-wallet.use-case.ts
│   │   └── utils/
│   │       ├── canonical-json-hash.ts
│   │       ├── cursor.ts
│   │       └── outbox-events.ts
│   ├── infra/
│   │   ├── database/
│   │   │   ├── data-source.ts
│   │   │   ├── postgres-uow.ts
│   │   │   └── migrations/
│   │   │       └── 1730000000000-initial-schema.ts
│   │   ├── messaging/
│   │   │   └── workers.ts
│   │   └── observability/
│   │       └── runtime-services.ts
│   └── presentation/
│       └── http/
│           ├── all-exceptions.filter.ts
│           └── http.controllers.ts
└── test/
    ├── unit/
    │   ├── domain/
    │   │   ├── money.test.ts
    │   │   ├── reversal-policy.test.ts
    │   │   ├── wager-transaction.test.ts
    │   │   ├── wallet-ledger-entry.test.ts
    │   │   └── wallet.test.ts
    │   ├── application/
    │   │   ├── canonical-hash-and-parsers.test.ts
    │   │   └── reconcile-queries-events.test.ts
    │   ├── infra/
    │   │   └── workers.test.ts
    │   └── presentation/
    │       └── http.test.ts
    └── integration/
        ├── test-harness.ts
        ├── concurrency-and-idempotency.integration.test.ts
        ├── wager-lifecycle-and-reversals.integration.test.ts
        └── ledger-outbox-and-sqs.integration.test.ts
```

### Principais Módulos

- **`src/domain/`:** Contém as entidades e objetos de valor (`Money`, `Currency`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`), a política de reversão (`reversal-policy.ts`), o cálculo de backoff (`backoff.ts`), os eventos (`wager-events.ts`) e os erros de negócio.
- **`src/application/dto/`:** Classes de transferência de dados para entrada (`wager-transaction-command.ts`) e formatação de saída (`views.ts`).
- **`src/application/ports/`:** Contratos e interfaces (`UnitOfWorkPort`, repositórios, logger, métricas e relógio) que definem como o núcleo da aplicação conversa com o mundo externo.
- **`src/application/use-cases/` e `utils/`:** Implementação dos fluxos de criação de carteira, processamento de apostas, listagem paginada, reconciliação e utilitários (`canonical-json-hash.ts`, cursor em `base64url` e montagem de eventos da outbox).
- **`src/infra/database/`:** Conexão do TypeORM (`data-source.ts`), unidade de trabalho transacional (`postgres-uow.ts`) e migration inicial com schema, constraints e triggers do ledger.
- **`src/infra/messaging/` e `observability/`:** Cliente SQS e workers (`SqsConsumerWorker`, `OutboxPublisherWorker` e `PendingReferenceRetryWorker` em `workers.ts`), além de logs estruturados em JSON e métricas (`runtime-services.ts`).
- **`src/presentation/http/`:** Controllers HTTP (`WalletsController`, `WageringController`, `HealthController`) e o `AllExceptionsFilter`, que converte erros de domínio nos status HTTP adequados (`400`, `404`, `409`, `422`, `503`).

---

## 4. Tecnologias e Pré-requisitos

| Componente | Tecnologia | Versão |
|---|---|---|
| Runtime, Package Manager & Test Runner | **Bun** | `^1.4.4` |
| Linguagem | **TypeScript** (`strict: true`) | `^7.0.2` |
| Framework Backend | **NestJS** | `^12.3.2` |
| Banco de Dados & Acesso | **PostgreSQL 16** + **TypeORM** / **pg** | `16-alpine` / `^1.1.2` / `^8.23.1` |
| Cálculos Monetários | **decimal.js** | `^10.6.0` |
| Mensageria | **AWS SDK SQS v3** + **LocalStack** | `^3.1159.0` / `localstack:3` |

### Requisitos do Ambiente
- **Docker Desktop** (com `docker compose` disponível)
- **Bun** instalado (`>= 1.1`)

---

## 5. Como Executar o Projeto e os Testes

### 1. Configurar variáveis de ambiente
No Linux/macOS/Git Bash:
```bash
cp .env.example .env
```
No Windows PowerShell:
```powershell
Copy-Item .env.example .env
```

### 2. Subir PostgreSQL e LocalStack
```bash
docker compose up -d
```
> Na subida, o Postgres executa `docker/postgres/init-test-db.sql` (criando o banco `wagering_test`) e o LocalStack executa `docker/localstack/init-sqs.sh` (criando as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`).

### 3. Instalar dependências
```bash
bun install
```

### 4. Comandos de Teste
| Comando | O que faz |
|---|---|
| `bun run typecheck` | Valida a tipagem TypeScript em todos os 44 arquivos do projeto. |
| `bun run test:unit` | Roda os **90 testes unitários** (`test/unit/`). Não precisa do Docker rodando. |
| `bun run test:integration` | Roda os **13 testes de integração e concorrência** (`test/integration/`) no PostgreSQL e LocalStack reais. |
| `bun test` | Executa todos os **103 testes** (unitários + integração). |
| `bun run migration:run` | Roda apenas as migrations no banco principal. |

### 5. Rodar a API (Terminal 1)
```bash
bun run start
```
> A aplicação aplica as migrations automaticamente, inicia os workers em segundo plano e sobe o servidor em `http://localhost:3000`.

Para desligar os containers quando terminar:
```bash
docker compose down
```

---

## 6. Testando na Prática (Terminal 2 - PowerShell)

Deixe o **Terminal 1** aberto rodando `bun run start` e, em um **segundo terminal PowerShell**, execute os comandos abaixo para testar o fluxo completo:

### 1º Healthcheck
```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/health" | ConvertTo-Json -Depth 5
```

### 2º Criar a carteira com R$ 100,00
```powershell
$playerId = [guid]::NewGuid().ToString()
$wallet = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/wallets" `
  -ContentType "application/json" `
  -Body (@{
    playerId = $playerId
    initialBalance = @{ amount = "100.00"; currency = "BRL" }
  } | ConvertTo-Json)

$walletId = $wallet.id
$wallet | ConvertTo-Json -Depth 5
```

### 3º Fazer uma aposta (`BET`) de R$ 25,00 (Saldo vai para R$ 75,00)
```powershell
$betBody = @{
  providerId = "provider-jungle"
  externalTransactionId = "bet-001"
  playerId = $playerId
  walletId = $walletId
  roundId = "round-100"
  gameId = "fortune-chimp"
  kind = "BET"
  money = @{ amount = "25.00"; currency = "BRL" }
} | ConvertTo-Json

$bet = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/wagering/transactions" `
  -Headers @{ "Idempotency-Key" = "provider-jungle:bet-001" } `
  -ContentType "application/json" `
  -Body $betBody

$bet | ConvertTo-Json -Depth 5
```

### 4º Testar Idempotência (Repetir a mesma `BET`)
Retorna `idempotentReplay: true` e mantém o saldo em `75.00 BRL`:
```powershell
$betReplay = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/wagering/transactions" `
  -Headers @{ "Idempotency-Key" = "provider-jungle:bet-001" } `
  -ContentType "application/json" `
  -Body $betBody

$betReplay | ConvertTo-Json -Depth 5
```

### 5º Registrar um ganho (`WIN`) de R$ 60,00 (Saldo vai para R$ 135,00)
```powershell
$winBody = @{
  providerId = "provider-jungle"
  externalTransactionId = "win-001"
  playerId = $playerId
  walletId = $walletId
  roundId = "round-100"
  gameId = "fortune-chimp"
  kind = "WIN"
  referenceExternalTransactionId = "bet-001"
  money = @{ amount = "60.00"; currency = "BRL" }
} | ConvertTo-Json

$win = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/wagering/transactions" `
  -Headers @{ "Idempotency-Key" = "provider-jungle:win-001" } `
  -ContentType "application/json" `
  -Body $winBody

$win | ConvertTo-Json -Depth 5
```

### 6º Consultar o extrato do Ledger (`OPENING`, `BET`, `WIN`)
```powershell
$ledger = Invoke-RestMethod -Method Get -Uri "http://localhost:3000/wallets/$walletId/ledger?limit=10"
$ledger | ConvertTo-Json -Depth 6
```

### 7º Conferir a Reconciliação da Carteira
Compara o saldo salvo na carteira com a soma das entradas do ledger (`consistent: true`, `difference: "0.00"`):
```powershell
$reconciliation = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/wallets/$walletId/reconciliation"
$reconciliation | ConvertTo-Json -Depth 5
```

---

## 7. Testes Obrigatórios do Desafio (Seção 13)

Todos os cenários exigidos na Seção 13 estão cobertos em `test/integration/` rodando contra o PostgreSQL 16 e o LocalStack SQS:

| Cenário Obrigatório | Arquivo | Teste | Resultado Validado |
|---|---|---|---|
| **1. Mesma aposta enviada 50 vezes em paralelo** (`Promise.all`) | `test/integration/concurrency-and-idempotency.integration.test.ts` | `50 requisições paralelas com a mesma Idempotency-Key resultam em um único débito` | 1 criação (`201`), 49 replays (`200`, `idempotentReplay: true`), apenas 1 débito no ledger e reconciliação consistente. |
| **2. Corrida de saldo: R$ 100,00 com 2 apostas simultâneas de R$ 80,00** | `test/integration/concurrency-and-idempotency.integration.test.ts` | `Cenário Seção 8: saldo 100.00 BRL com 2 BETs simultâneas de 80.00 BRL -> saldo final 20.00 BRL` | 1 aposta `PROCESSED`, 1 `REJECTED` (`INSUFFICIENT_FUNDS`), saldo final `20.00 BRL`. |
| **3. Concorrência de 10 apostas simultâneas de R$ 25,00 em saldo de R$ 100,00** | `test/integration/concurrency-and-idempotency.integration.test.ts` | `10 BETs simultâneas de 25.00 BRL em saldo de 100.00 BRL: 4 PROCESSED, 6 REJECTED e saldo 0.00` | 4 aprovadas (`201`), 6 rejeitadas (`422`), saldo `0.00 BRL`, `version = 5` e `sequence` de `1` a `5`. |
| **4. Conflito de Idempotência (mesma chave com payload alterado)** | `test/integration/concurrency-and-idempotency.integration.test.ts` | `mesma Idempotency-Key com payload divergente retorna 409 Conflict` | Retorna `409 Conflict` sem alterar saldo. |
| **5. Múltiplas instâncias simultâneas (`>= 3`)** | `test/integration/concurrency-and-idempotency.integration.test.ts` | `3 instâncias simultâneas da aplicação processando carteiras distintas e compartilhadas em paralelo` | 3 instâncias NestJS independentes processando sobre o mesmo banco sem perda de atualização. |
| **6. `ROLLBACK` / `REFUND` antes da `BET` (Fora de ordem e TTL)** | `test/integration/wager-lifecycle-and-reversals.integration.test.ts` | `ROLLBACK entregue antes da BET entra em PENDING_REFERENCE (202) e é resolvido pelo worker após a BET chegar` e `PENDING_REFERENCE reagenda com backoff exponencial e expira como REJECTED (REFERENCE_NOT_FOUND) após o TTL` | Entra como `PENDING_REFERENCE` (`202`), resolve via worker quando a `BET` chega ou expira como `REJECTED` após o TTL. |
| **7. Bloqueio de dupla reversão e saldo negativo em reversão** | `test/integration/wager-lifecycle-and-reversals.integration.test.ts` | `bloqueia dupla reversão (REFERENCE_ALREADY_REVERSED) e reversão de WIN que deixaria saldo negativo (NEGATIVE_BALANCE_ON_REVERSAL)` | Rejeita 2ª reversão com `REFERENCE_ALREADY_REVERSED` e bloqueia `ROLLBACK` de `WIN` sem saldo. |
| **8. Dois publishers concorrentes na mesma Outbox** | `test/integration/ledger-outbox-and-sqs.integration.test.ts` | `dois OutboxPublisherWorkers concorrentes publicam eventos no SQS (LocalStack) via SKIP LOCKED` | Publicam no SQS sem conflito usando `FOR UPDATE SKIP LOCKED`. |
| **9. Consumidor SQS, redelivery antes do ACK e DLQ** | `test/integration/ledger-outbox-and-sqs.integration.test.ts` | `SqsConsumerWorker processa mensagem da fila, deduplica redelivery via Inbox e envia poison message para DLQ` | Deduplica via `inbox_messages` sem debitar duas vezes e move JSON inválido para a fila DLQ. |
| **10. Imutabilidade do Ledger e Paginação** | `test/integration/ledger-outbox-and-sqs.integration.test.ts` | `triggers PostgreSQL bloqueiam UPDATE, DELETE e TRUNCATE em wallet_ledger_entries` e `paginação do ledger por cursor opaco percorre todas as entradas sem duplicar nem pular` | Triggers do Postgres bloqueiam tentativas diretas de mutação ou limpeza da tabela do ledger. |

---

## 8. Observações Importantes e Garantias (Seção 14)

| Regra do Desafio | Como foi garantida no código | Teste que valida |
|---|---|---|
| **1. Dinheiro nunca é `number`** | `Money.fromString` (`src/domain/models/money.ts`) exige string formatada, opera com `decimal.js` e grava em `NUMERIC(18, 2)`. | `test/unit/domain/money.test.ts` |
| **2. Impossível saldo negativo** | Lock `SELECT ... FOR UPDATE` (`src/infra/database/postgres-uow.ts`), validação `Wallet.canDebit` e `CHECK (balance_amount >= 0)` no banco. | `test/integration/concurrency-and-idempotency.integration.test.ts` |
| **3. Sem débito ou crédito duplicado** | Constraints `UNIQUE` de chave de idempotência, transação externa, índice parcial de reversão e tabela `inbox_messages`. | `test/integration/concurrency-and-idempotency.integration.test.ts` |
| **4. Idempotência persistente em todo momento** | Persistida no PostgreSQL dentro da mesma transação da carteira, mantendo o histórico mesmo se a aplicação reiniciar. | `test/integration/ledger-outbox-and-sqs.integration.test.ts` |
| **5. Funciona com múltiplas instâncias** | Nenhum lock em memória local; coordenação feita no PostgreSQL via `FOR UPDATE` e `FOR UPDATE SKIP LOCKED`. | `test/integration/concurrency-and-idempotency.integration.test.ts` |
| **6. Evento nunca publicado antes do commit** | Eventos são salvos na tabela `outbox_messages` na mesma transação SQL e publicados no SQS apenas após o `COMMIT`. | `test/integration/ledger-outbox-and-sqs.integration.test.ts` |
| **7. Ledger auditável e imutável** | Equação validada por `CHECK` (`ck_ledger_equation`), triggers bloqueando `UPDATE`/`DELETE`/`TRUNCATE` e rota de reconciliação. | `test/integration/ledger-outbox-and-sqs.integration.test.ts` |
| **8. Testes reais com PostgreSQL e SQS** | Testes de integração rodam direto contra os containers do PostgreSQL 16 e LocalStack SQS, sem mocks de infraestrutura. | `test/integration/*.integration.test.ts` |

---

## 9. Trade-offs Conhecidos

- **Serialização por carteira (`SELECT ... FOR UPDATE`):** Apostas simultâneas de um mesmo jogador aguardam na fila do lock daquela linha no banco, o que evita *lost updates* e *retry storms* de lock otimista, enquanto outros jogadores continuam rodando em paralelo.
- **Entrega *At-Least-Once* na Outbox:** Se o processo cair exatamente após enviar a mensagem ao SQS e antes de marcar `PUBLISHED` no banco, o evento pode ser reenviado. Para lidar com isso, usamos `MessageDeduplicationId` na fila FIFO e `eventId` único no payload para deduplicação no consumidor.
- **Retentativa assíncrona em `PENDING_REFERENCE`:** Reversões que chegam antes da aposta original não travam a requisição HTTP; elas retornam `202 Accepted` e são reprocessadas pelo worker com *exponential backoff* até a aposta chegar ou até expirarem no limite de `PENDING_TTL_SECONDS`.