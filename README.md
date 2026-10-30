# Backend Jungle Gaming — Distributed Wagering & Wallet Ledger Engine (DESAFIO TÉCNICO)

Motor financeiro distribuído de alta confiabilidade para processamento de transações de apostas (*wagering*) multi-provedor e gestão de carteiras com razão contábil (*ledger*) imutável.

---

## 1. Introdução e Visão Geral

Este serviço processa operações financeiras de rodadas de jogos (`BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`) originadas de múltiplos provedores, tanto de forma síncrona via API **HTTP REST** quanto assíncrona via **AWS SQS FIFO**.

A arquitetura foi projetada para sustentar as invariantes financeiras sob entregas *at-least-once*, mensagens duplicadas, eventos fora de ordem e alta concorrência entre múltiplas instâncias da aplicação:

- **Correção financeira absoluta:** Proibição estrita de `number`, `float` ou `double` em tempo de compilação e de execução. Todos os valores monetários trafegam como strings decimais validadas (`^\d+\.\d{2}$`), são operados em ponto fixo exato via `decimal.js` no Value Object `Money` (`src/domain/models/money.ts`) e armazenados como `NUMERIC(18, 2)` no PostgreSQL, com `sequence` do razão contábil em `BIGSERIAL` (`bigint`).
- **Concorrência segura entre múltiplas instâncias:** Arquitetura *stateless* onde a unidade de concorrência é a carteira (`walletId`). Operações simultâneas na mesma carteira são serializadas no PostgreSQL via bloqueio pessimista de linha (`SELECT ... FOR UPDATE`), enquanto carteiras distintas são processadas 100% em paralelo.
- **Idempotência persistente e determinística:** Deduplicação garantida no banco de dados pelas restrições únicas `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` aliadas ao cálculo de hash `SHA-256` sobre o JSON canônico do payload (`canonicalJsonHash`). Replays idênticos retornam o estado original (`idempotentReplay: true`) e payloads divergentes com a mesma chave são bloqueados com `409 Conflict`.
- **Consistência entre saldo materializado e ledger:** Cada alteração de saldo gera, na mesma transação ACID, um lançamento contábil sequencial (`sequence`) em `wallet_ledger_entries` contendo `balance_before`, `amount`, `direction` e `balance_after`. A tabela do ledger é fisicamente *append-only*, protegida por constraints `CHECK` da equação contábil e por triggers nativos em PL/pgSQL que bloqueiam `UPDATE`, `DELETE` e `TRUNCATE`.
- **Processamento assíncrono resiliente:** Uso combinado dos padrões *Transactional Outbox* (nenhum evento é publicado antes do `COMMIT`), *Transactional Inbox* (deduplicação persistente de entregas SQS por `(consumer_name, message_id)`), encaminhamento de *poison messages* para Dead-Letter Queue (DLQ) e resolução automática de referências fora de ordem (`PENDING_REFERENCE`) com *exponential backoff* e expiração por TTL.

---

## 2. Decisões Técnicas e Fluxo Principal de Processamento

### Arquitetura em Camadas (Clean Architecture / Ports & Adapters + DDD Tático)

O projeto adota **Clean Architecture** combinada com **DDD Tático**. As camadas internas (`src/domain/` e `src/application/`) possuem **zero dependências** de NestJS, TypeORM, driver `pg` ou AWS SDK:

1. **Domínio (`src/domain/`):** Concentra os agregados, entidades, Value Objects, políticas puras de reversão e eventos de integração. Construtores são privados e toda mutação exige validação explícita de invariantes.
2. **Aplicação (`src/application/`):** Orquestra o fluxo transacional através da porta `UnitOfWorkPort` (`TransactionalContext`), expondo casos de uso reutilizados igualmente pelo controller HTTP e pelo worker consumidor SQS.
3. **Infraestrutura e Apresentação (`src/infra/` e `src/presentation/`):** Implementam as portas com SQL parametrizado explícito sobre o `QueryRunner` do TypeORM (`PostgresUnitOfWork`), workers SQS com `@aws-sdk/client-sqs` e controllers NestJS.

### Fluxo Principal Passo a Passo

1. **Abertura de Carteira (`CreateWalletUseCase`):**
   - Ao receber `POST /wallets`, uma transação SQL é aberta via `PostgresUnitOfWork.run()`.
   - Verifica-se a unicidade de `(playerId, currency)`. A carteira é criada com `version = 1`.
   - Se `initialBalance > 0`, são gravados na **mesma transação SQL**: uma transação interna `OPENING` (`PROCESSED`), um lançamento `CREDIT` no ledger (`balance_before = 0.00`, `balance_after = initialBalance`) e os eventos `WagerTransactionProcessed` e `WalletBalanceChanged` na tabela `outbox_messages`.
2. **Recebimento e Normalização da Transação (`parseWagerTransactionCommand`):**
   - A requisição chega via `POST /wagering/transactions` (exigindo o header `Idempotency-Key`) ou via fila `wager-transactions.fifo` no `SqsConsumerWorker`.
   - O parser valida tipos, formato monetário estrito e calcula o `payloadHash` (`SHA-256` em hex) sobre as chaves de negócio ordenadas recursivamente (`canonicalJsonHash`).
3. **Abertura da Unit of Work e Lock Pessimista (`ProcessWagerTransactionUseCase`):**
   - Inicia-se uma transação `READ COMMITTED` no PostgreSQL (com retry automático em caso de `UniqueConstraintViolationError` concorrente ou `TransientDatabaseError`).
   - Executa-se `SELECT * FROM wallets WHERE id = $1 FOR UPDATE`, serializando qualquer operação concorrente sobre aquela carteira específica.
4. **Deduplicação Inbox (SQS) e Idempotência Persistente:**
   - Se a origem for SQS, registra-se a mensagem na tabela `inbox_messages` via `INSERT ... ON CONFLICT (consumer_name, message_id) DO NOTHING`. Se já processada, retorna o resultado original sem reexecutar efeitos.
   - Consulta-se `wager_transactions` por `idempotency_key` ou `(provider_id, external_transaction_id)`. Se existir com o mesmo `payload_hash`, retorna replay (`idempotentReplay: true`). Se o `payload_hash` divergir, lança `IdempotencyConflictError` (`409 Conflict`).
5. **Avaliação das Regras Financeiras e de Reversão:**
   - Valida-se a titularidade (`playerId`) e a moeda (`currency`) da carteira.
   - **`BET`:** Verifica saldo disponível (`canDebit`). Se suficiente, debita o saldo e incrementa `version`; se insuficiente, registra a transação como `REJECTED` (`INSUFFICIENT_FUNDS`) sem alterar saldo nem `version` e sem gerar lançamento no ledger.
   - **`WIN`:** Credita o valor na carteira e incrementa `version`.
   - **`LOSS`:** Registra a transação como `PROCESSED` sem alterar saldo, sem incrementar `version` e sem gerar entrada no ledger.
   - **`REFUND` / `ROLLBACK` (`evaluateReversal`):** Busca a transação referenciada por `(providerId, referenceExternalTransactionId)` e verifica se já foi revertida (`isReversed`).
     - Se a referência ainda não chegou ou está pendente, persiste como `PENDING_REFERENCE` (`202 Accepted`) com `next_retry_at` e `expires_at`.
     - Se a referência for válida e `PROCESSED`, aplica `CREDIT` (reversão de `BET`) ou `DEBIT` (reversão de `WIN`/`REFUND`). Caso o débito de reversão deixasse o saldo negativo, rejeita com `NEGATIVE_BALANCE_ON_REVERSAL` (`422 Unprocessable Entity`).
6. **Persistência Atômica e Commit:**
   - Na mesma transação SQL, insere/atualiza o registro em `wager_transactions`, atualiza `wallets`, insere o lançamento imutável em `wallet_ledger_entries` e enfileira os eventos de domínio correspondentes em `outbox_messages`.
   - Executa o `COMMIT`. No caso do SQS, o `DeleteMessage` (ACK) só ocorre após o `COMMIT`.
7. **Publicação Assíncrona e Reprocessamento em Background:**
   - O `OutboxPublisherWorker` lê lotes pendentes com `SELECT ... FOR UPDATE SKIP LOCKED`, publica na fila `wager-events.fifo` e marca como `PUBLISHED`.
   - O `PendingReferenceRetryWorker` reclama transações `PENDING_REFERENCE` vencidas via `FOR UPDATE SKIP LOCKED` e reexecuta a decisão sob o lock da carteira até resolver ou expirar por TTL.

### Principais Decisões de Arquitetura

| Decisão | Motivo Técnico | Arquivo onde está implementado |
|---|---|---|
| **Aritmética decimal estrita (`decimal.js` + `NUMERIC(18, 2)`)** | Elimina imprecisões IEEE 754 (`0.1 + 0.2`) e rejeita `number` nativo em runtime. | `src/domain/models/money.ts` |
| **SQL parametrizado explícito sobre `QueryRunner`** | Controle total e transparente sobre `SELECT ... FOR UPDATE`, `FOR UPDATE SKIP LOCKED`, `ON CONFLICT DO NOTHING` e isolamento `REPEATABLE READ READ ONLY`. | `src/infra/database/postgres-uow.ts` |
| **Lock pessimista por carteira (`FOR UPDATE`)** | Evita *lost updates* e *race conditions* em *hot wallets* sem travar carteiras de outros jogadores. | `src/infra/database/postgres-uow.ts` / `src/application/use-cases/process-wager-transaction.use-case.ts` |
| **Hash SHA-256 de JSON Canônico** | Garante que payloads com chaves em ordens diferentes produzam o mesmo hash na validação de conflito de idempotência. | `src/application/utils/canonical-json-hash.ts` |
| **Triggers PL/pgSQL + `CHECK` no Schema** | Aplica invariantes financeiras e imutabilidade física (*append-only*) do ledger diretamente no motor do PostgreSQL. | `src/infra/database/migrations/1730000000000-initial-schema.ts` |
| **Índice Único Parcial de Reversão (`uq_single_processed_reversal`)** | Impede no nível do banco que duas transações concorrentes revertam a mesma operação de referência. | `src/infra/database/migrations/1730000000000-initial-schema.ts` |
| **Reconciliação em `REPEATABLE READ READ ONLY`** | Lê o saldo materializado e a soma histórica do ledger no mesmo *snapshot* transacional, sem falsos positivos e sem bloquear escritas. | `src/application/use-cases/reconcile-wallet.use-case.ts` |

---

## 3. Estrutura do Projeto e Principais Módulos

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

### Responsabilidade de Cada Módulo

- **`src/domain/` (`models`, `services`, `events`, `errors`):** Núcleo financeiro puro. Contém o Value Object `Money` e o tipo nominal `Currency`, o Aggregate Root `Wallet`, a máquina de estados `WagerTransaction`, o lançamento imutável `WalletLedgerEntry` (congelado via `Object.freeze` e validando `balanceBefore ± amount == balanceAfter`), as entidades `InboxMessage` e `OutboxMessage`, a política pura de estorno `evaluateReversal` (`reversal-policy.ts`), o cálculo de `exponentialBackoffMs` (`backoff.ts`), a hierarquia `IntegrationEvent<TPayload>` (`wager-events.ts`) e os erros de domínio (`domain-errors.ts` e `failure-code.ts`).
- **`src/application/dto/`:** Contratos e parsers de entrada (`wager-transaction-command.ts`) e projeções de saída (`WalletView`, `TransactionView`, `LedgerEntryView`, `LedgerPageView` e `ReconciliationView` em `views.ts`).
- **`src/application/ports/`:** Interfaces que desacoplam a aplicação da infraestrutura (`UnitOfWorkPort`, `TransactionalContext`, `WalletRepositoryPort`, `WagerTransactionRepositoryPort`, `WalletLedgerRepositoryPort`, `InboxRepositoryPort`, `OutboxRepositoryPort`, `ClockPort`, `IdGeneratorPort`, `LoggerPort` e `MetricsPort`).
- **`src/application/use-cases/` e `utils/`:** Casos de uso de criação de carteira (`create-wallet.use-case.ts`), processamento transacional e retentativa de pendentes (`process-wager-transaction.use-case.ts`), consultas paginadas (`queries.use-case.ts`), reconciliação contábil (`reconcile-wallet.use-case.ts`) e utilitários (`canonical-json-hash.ts`, paginação opaca em ` base64url` em `cursor.ts` e serialização de eventos em `outbox-events.ts`).
- **`src/infra/database/`:** Configuração do `DataSource` do TypeORM (`data-source.ts`), implementação da `PostgresUnitOfWork` e de todos os repositórios transacionais em SQL explícito (`postgres-uow.ts`), além da migration reversível `1730000000000-initial-schema.ts` com DDL, índices parciais, constraints `CHECK` e triggers PL/pgSQL de imutabilidade.
- **`src/infra/messaging/` e `observability/`:** Cliente `AwsSqsClient` e os 3 workers de background com suporte a `runOnce()` e desligamento gracioso em `SIGTERM` (`SqsConsumerWorker`, `OutboxPublisherWorker` e `PendingReferenceRetryWorker` em `workers.ts`), além de `SystemClock`, `CryptoIdGenerator`, `StructuredJsonLogger` (com *allowlist* de metadados seguros) e `InMemoryMetrics` (`runtime-services.ts`).
- **`src/presentation/http/`:** Controllers REST (`WalletsController`, `WageringController` e `HealthController` em `http.controllers.ts`) e o filtro global de exceções `AllExceptionsFilter` (`all-exceptions.filter.ts`) que traduz erros de domínio em códigos HTTP semânticos (`400`, `404`, `409`, `422`, `503` e `500`).

---

## 4. Tecnologias, Dependências e Requisitos do Ambiente

### Stack e Versões (`package.json` e `docker-compose.yml`)

| Componente | Tecnologia / Pacote | Versão |
|---|---|---|
| Runtime, Package Manager & Test Runner | **Bun** (`oven/bun`) | `1.x` (`^1.4.4`) |
| Linguagem | **TypeScript** (`strict: true`) | `^7.0.2` |
| Framework HTTP / DI | **NestJS** (`@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`) | `^12.3.2` |
| Acesso a Dados & Migrations | **TypeORM** + driver **pg** | `^1.1.2` / `^8.23.1` |
| Precisão Monetária | **decimal.js** | `^10.6.0` |
| Mensageria AWS SQS | **AWS SDK v3** (`@aws-sdk/client-sqs`) | `^3.1159.0` |
| Banco de Dados Relacional | **PostgreSQL** (`postgres:16-alpine`) | `16` |
| Emulador Cloud Local (SQS FIFO) | **LocalStack** (`localstack/localstack:3`) | `3` |

### Requisitos da Máquina

- **Docker Desktop** (com `docker compose` ativo) para subir o PostgreSQL 16 (`porta 5432`) e o LocalStack (`porta 4566`).
- **Bun** (`>= 1.1`) instalado no sistema operacional.

---

## 5. Como Executar o Projeto e Rodar os Testes

### Passo a Passo de Configuração

1. **Criar o arquivo `.env` a partir do modelo `.env.example`:**

   No Linux/macOS/Git Bash:
   ```bash
   cp .env.example .env
   ```
   No Windows PowerShell:
   ```powershell
   Copy-Item .env.example .env
   ```

2. **Subir os containers de infraestrutura (PostgreSQL 16 + LocalStack SQS FIFO):**

   ```bash
   docker compose up -d
   ```
   *O container `wagering-postgres` executa automaticamente `docker/postgres/init-test-db.sql` (criando o banco `wagering_test`), e o container `wagering-localstack` executa `docker/localstack/init-sqs.sh` (provisionando as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`).*

3. **Instalar as dependências do projeto:**

   ```bash
   bun install
   ```

### Comandos de Teste e Verificação

| Comando | Descrição e Escopo de Validação |
|---|---|
| `bun run typecheck` | Executa a checagem estrita de tipos (`bun check`) nos 44 arquivos TypeScript do projeto (0 erros). |
| `bun run test:unit` | Executa os **90 testes unitários** rápidos (`test/unit/`) validando `Money`, `Currency`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, `evaluateReversal`, `canonicalJsonHash`, cursores, casos de uso, workers e filtro HTTP. |
| `bun run test:integration` | Executa os **13 testes de integração e concorrência real** (`test/integration/`) contra o PostgreSQL 16 (`wagering_test`) e LocalStack SQS reais. |
| `bun test` | Executa a suíte completa de **103 testes automatizados** (unitários + integração) em 12 arquivos. |
| `bun run migration:run` | Aplica apenas a migration inicial no banco configurado em `DATABASE_URL` e encerra o processo. |

### Iniciar a Aplicação (Terminal 1)

```bash
bun run start
```
*O bootstrap aplica automaticamente as migrations pendentes, inicia os 3 workers em background (`SqsConsumerWorker`, `OutboxPublisherWorker` e `PendingReferenceRetryWorker`) e expõe a API HTTP na porta `3000`.*

### Desligar os Containers ao Finalizar

```bash
docker compose down
```

---

## 6. Como Funciona na Prática: Fazendo uma Bet e Auditando o Ledger (Terminal 2 - PowerShell)

Com o **Terminal 1** executando `bun run start`, abra um **Terminal 2** no Windows PowerShell e cole os blocos abaixo em sequência para exercitar o fluxo financeiro completo:

### 1º Passo: Healthcheck (Liveness, Readiness e Conexão com o Banco)
```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:3000/health" | ConvertTo-Json -Depth 5
```

### 2º Passo: Criar Conta/Carteira com Saldo Inicial de `100.00 BRL`
Cria a carteira (`version = 1`) e gera atomicamente a transação `OPENING` e o 1º lançamento `CREDIT` no ledger:
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

### 3º Passo: Fazer uma Aposta (`BET`) de `25.00 BRL`
Debita `25.00 BRL` da carteira, atualizando o saldo para `75.00 BRL` (`HTTP 201 Created`, `idempotentReplay: false`):
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

### 4º Passo: Testar a Idempotência (Repetir o Envio da Mesma `BET`)
Reenviar a mesma requisição com a mesma `Idempotency-Key` retorna `HTTP 200 OK` com `idempotentReplay: true` e mantém o saldo intacto em `75.00 BRL`:
```powershell
$betReplay = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/wagering/transactions" `
  -Headers @{ "Idempotency-Key" = "provider-jungle:bet-001" } `
  -ContentType "application/json" `
  -Body $betBody

$betReplay | ConvertTo-Json -Depth 5
```

### 5º Passo: Registrar Resultado de Ganho (`WIN`) de `60.00 BRL`
Credita `60.00 BRL` na mesma rodada referenciando a aposta anterior (`referenceExternalTransactionId = "bet-001"`), elevando o saldo para `135.00 BRL`:
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

### 6º Passo: Consultar o Extrato Imutável do Ledger
Retorna a sequência encadeada de lançamentos (`OPENING` -> `BET` -> `WIN`) com `balanceBefore`, `balanceAfter` e `sequence`:
```powershell
$ledger = Invoke-RestMethod -Method Get -Uri "http://localhost:3000/wallets/$walletId/ledger?limit=10"
$ledger | ConvertTo-Json -Depth 6
```

### 7º Passo: Executar a Reconciliação Contábil (`POST /wallets/:id/reconciliation`)
Recalcula o saldo diretamente pela soma algébrica do ledger (`Σ CREDIT − Σ DEBIT`) sob snapshot `REPEATABLE READ READ ONLY` e comprova `consistent: true` e `difference.amount: "0.00"`:
```powershell
$reconciliation = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/wallets/$walletId/reconciliation"
$reconciliation | ConvertTo-Json -Depth 5
```

---

## 7. Cobertura dos Testes Obrigatórios (Seção 13 do Desafio)

Todos os cenários obrigatórios de integração e concorrência real são executados contra instâncias reais do PostgreSQL 16 e LocalStack em `test/integration/`:

| Cenário Obrigatório (Seção 13) | Arquivo de Teste | Caso de Teste (`test(...)`) | Resultado Comprovado |
|---|---|---|---|
| **1. Mesma aposta enviada 50 vezes em paralelo** (`Promise.all`) | `test/integration/concurrency-and-idempotency.integration.test.ts` | `50 requisições paralelas com a mesma Idempotency-Key resultam em um único débito` | Exatamente 1 criação (`201`, `idempotentReplay: false`), 49 replays (`200`, `idempotentReplay: true`), 1 único débito no ledger e `consistent: true`. |
| **2. Corrida de saldo na mesma carteira (Seção 8: `100.00 BRL` com 2 apostas simultâneas de `80.00 BRL`)** | `test/integration/concurrency-and-idempotency.integration.test.ts` | `Cenário Seção 8: saldo 100.00 BRL com 2 BETs simultâneas de 80.00 BRL -> saldo final 20.00 BRL` | 1 aposta `PROCESSED`, 1 aposta `REJECTED` (`INSUFFICIENT_FUNDS`), saldo final `20.00 BRL` e apenas 1 débito no ledger. |
| **3. Concorrência extrema em *Hot Wallet* (10 apostas simultâneas de `25.00 BRL` em saldo de `100.00 BRL`)** | `test/integration/concurrency-and-idempotency.integration.test.ts` | `10 BETs simultâneas de 25.00 BRL em saldo de 100.00 BRL: 4 PROCESSED, 6 REJECTED e saldo 0.00` | 4 aprovadas (`201`), 6 rejeitadas (`422`), saldo `0.00 BRL`, `version = 5` e `sequence` contínua `1..5`. |
| **4. Conflito de Idempotência (mesma chave com payload adulterado)** | `test/integration/concurrency-and-idempotency.integration.test.ts` | `mesma Idempotency-Key com payload divergente retorna 409 Conflict` | Rejeita com `409 Conflict` (`IdempotencyConflictError`) sem alterar o saldo da carteira. |
| **5. Múltiplas instâncias simultâneas (`>= 3` instâncias) e carteiras distintas em paralelo** | `test/integration/concurrency-and-idempotency.integration.test.ts` | `3 instâncias simultâneas da aplicação processando carteiras distintas e compartilhadas em paralelo` | 3 instâncias NestJS independentes sobre o mesmo banco processam múltiplos jogadores sem *lost updates*. |
| **6. `ROLLBACK` ou `REFUND` entregue antes da transação referenciada (Fora de Ordem + Expiração TTL)** | `test/integration/wager-lifecycle-and-reversals.integration.test.ts` | `ROLLBACK entregue antes da BET entra em PENDING_REFERENCE (202) e é resolvido pelo worker após a BET chegar` e `PENDING_REFERENCE reagenda com backoff exponencial e expira como REJECTED (REFERENCE_NOT_FOUND) após o TTL` | Aceita com `202 Accepted` (`PENDING_REFERENCE`), resolve para `PROCESSED` via worker quando a `BET` chega, ou expira como `REJECTED` (`REFERENCE_NOT_FOUND`) após o TTL. |
| **7. Proteção contra dupla reversão e saldo negativo em estorno de ganho** | `test/integration/wager-lifecycle-and-reversals.integration.test.ts` | `bloqueia dupla reversão (REFERENCE_ALREADY_REVERSED) e reversão de WIN que deixaria saldo negativo (NEGATIVE_BALANCE_ON_REVERSAL)` | Bloqueia a 2ª reversão com `REFERENCE_ALREADY_REVERSED` e impede `ROLLBACK` de `WIN` sem saldo com `NEGATIVE_BALANCE_ON_REVERSAL`. |
| **8. Dois publishers concorrentes sobre a mesma Outbox (`SKIP LOCKED`)** | `test/integration/ledger-outbox-and-sqs.integration.test.ts` | `dois OutboxPublisherWorkers concorrentes publicam eventos no SQS (LocalStack) via SKIP LOCKED` | Ambos publicam em paralelo na fila `wager-events.fifo` do LocalStack sem colisão e marcam todas as mensagens como `PUBLISHED`. |
| **9. Consumidor SQS, redelivery após falha antes do ACK e envio para DLQ** | `test/integration/ledger-outbox-and-sqs.integration.test.ts` | `SqsConsumerWorker processa mensagem da fila, deduplica redelivery via Inbox e envia poison message para DLQ` | Deduplica redelivery via `inbox_messages` sem duplicar débito e encaminha *poison messages* para `wager-transactions-dlq.fifo`. |
| **10. Imutabilidade física do Ledger e Paginação por Cursor** | `test/integration/ledger-outbox-and-sqs.integration.test.ts` | `triggers PostgreSQL bloqueiam UPDATE, DELETE e TRUNCATE em wallet_ledger_entries` e `paginação do ledger por cursor opaco percorre todas as entradas sem duplicar nem pular` | Qualquer `UPDATE`, `DELETE` ou `TRUNCATE` direto no SQL falha com exceção do trigger PL/pgSQL. |

---

## 8. Observações Importantes e Proteção contra Critérios Eliminatórios (Seção 14)

A tabela abaixo demonstra como cada uma das 8 falhas eliminatórias da especificação é impedida estruturalmente no código e no banco de dados:

| Regra Inviolável (Critério Eliminatório) | Como o Sistema Garante (Arquivos) | Teste Automatizado que Comprova |
|---|---|---|
| **1. Jamais usar `number`, `float` ou `double` para dinheiro** | `Money.fromString` (`src/domain/models/money.ts`) valida `typeof amount === 'string'` e regex `^\d+\.\d{2}$`, operando com `Decimal` (`decimal.js`) e persistindo em colunas `NUMERIC(18, 2)` com `sequence` em `BIGSERIAL` (`bigint`). | `test/unit/domain/money.test.ts` (`rejeita number nativo em tempo de execução` e `soma sem erro de ponto flutuante`) |
| **2. Impossibilidade de saldo negativo por *race condition*** | Lock pessimista `SELECT ... FOR UPDATE` em `WalletRepo.findByIdForUpdate` (`src/infra/database/postgres-uow.ts`), validação `Wallet.canDebit` (`src/domain/models/wallet.ts`) e constraint `CHECK (balance_amount >= 0)` no banco. | `test/integration/concurrency-and-idempotency.integration.test.ts` (`10 BETs simultâneas de 25.00 BRL em saldo de 100.00 BRL`) |
| **3. Prevenção de débito ou crédito duplicado** | Constraints `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`, índice parcial `uq_single_processed_reversal` e tabela `inbox_messages` (`UNIQUE (consumer_name, message_id)`). | `test/integration/concurrency-and-idempotency.integration.test.ts` (`50 requisições paralelas com a mesma Idempotency-Key`) |
| **4. Idempotência persistente em banco (nunca apenas em memória)** | Toda checagem de idempotência e inbox ocorre no PostgreSQL dentro da transação da `PostgresUnitOfWork`, sobrevivendo a reinícios de processo. | `test/integration/ledger-outbox-and-sqs.integration.test.ts` (`SqsConsumerWorker processa mensagem da fila, deduplica redelivery via Inbox`) |
| **5. Solução correta com múltiplas instâncias simultâneas** | Nenhum lock ou cache de estado reside na memória do processo Node/Bun; toda sincronização usa locks de linha (`FOR UPDATE` e `FOR UPDATE SKIP LOCKED`) no PostgreSQL. | `test/integration/concurrency-and-idempotency.integration.test.ts` (`3 instâncias simultâneas da aplicação processando carteiras distintas e compartilhadas`) |
| **6. Jamais publicar evento antes do commit da transação** | Eventos são gravados na tabela `outbox_messages` (`src/application/utils/outbox-events.ts`) dentro da mesma transação SQL da carteira/ledger e só são enviados ao SQS pelo `OutboxPublisherWorker` após o `COMMIT`. | `test/integration/ledger-outbox-and-sqs.integration.test.ts` (`dois OutboxPublisherWorkers concorrentes publicam eventos no SQS`) |
| **7. Presença de Ledger auditável e fisicamente imutável** | Constraint `ck_ledger_equation` (`balance_before ± amount = balance_after`) e triggers PL/pgSQL `trg_ledger_no_update_delete` e `trg_ledger_no_truncate` em `1730000000000-initial-schema.ts`, auditados via `ReconcileWalletUseCase`. | `test/integration/ledger-outbox-and-sqs.integration.test.ts` (`triggers PostgreSQL bloqueiam UPDATE, DELETE e TRUNCATE em wallet_ledger_entries`) |
| **8. Testes reais com PostgreSQL 16 e LocalStack SQS** | A suíte em `test/integration/` conecta-se diretamente ao PostgreSQL 16 (`wagering_test`) e ao LocalStack SQS reais provisionados via `docker-compose.yml`. | Todos os 13 testes em `test/integration/*.integration.test.ts` |

---

## 9. Limites Conhecidos e Trade-offs

1. **Lock Pessimista por Carteira em *Hot Wallets* (`SELECT ... FOR UPDATE`):**
   - **Trade-off:** Operações concorrentes destinadas à **mesma** carteira aguardam em fila no banco até o término da transação ativa, limitando a vazão máxima de um único jogador individual à latência de commit do PostgreSQL. Em contrapartida, elimina completamente o risco de *lost updates* e a tempestade de retentativas (*retry storms*) típica de *optimistic locking* sob alta contenção, mantendo carteiras de jogadores diferentes 100% paralelas.
2. **Semântica *At-Least-Once* no Transactional Outbox:**
   - **Trade-off:** Se o processo do `OutboxPublisherWorker` sofrer uma queda abrupta exatamente após o envio da mensagem ao SQS e antes do `COMMIT` que marca o registro como `PUBLISHED` no PostgreSQL, o evento poderá ser publicado novamente. Para mitigar esse efeito, o publisher utiliza `MessageDeduplicationId = outbox.id` na fila SQS FIFO (janela de deduplicação de 5 minutos) e inclui `eventId` único no envelope `IntegrationEvent` para deduplicação pelos consumidores *downstream*.
3. **Resolução Assíncrona de Referências Fora de Ordem (`PENDING_REFERENCE`):**
   - **Trade-off:** Quando um `REFUND` ou `ROLLBACK` chega antes da transação original referenciada, ele não bloqueia a thread HTTP/SQS esperando a referência; é persistido imediatamente como `PENDING_REFERENCE` (`202 Accepted`) e reavaliado periodicamente pelo `PendingReferenceRetryWorker` com *exponential backoff* (`baseMs * 2^attempt`). Caso a transação original jamais seja enviada pelo provedor dentro da janela de `PENDING_TTL_SECONDS` ou `PENDING_MAX_ATTEMPTS`, a transação transiciona de forma auditável para `REJECTED` com `failureCode = REFERENCE_NOT_FOUND`.
