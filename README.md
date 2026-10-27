# Jungle Wagering Processor — Distributed ACID Wallet & Ledger Engine

Motor transacional distribuído para processamento de apostas (*wagering*) de alta concorrência (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`), construído com **Bun**, **TypeScript 5 (Strict Mode)**, **NestJS**, **MikroORM**, **PostgreSQL 16** e **AWS SQS (LocalStack)**.

---

## 1. Destaques Arquiteturais & Garantias Financeiras

* **Hexagonal Architecture + DDD Tático**:
  * `src/domain`: Camada 100% pura e livre de dependências de framework. Contém o Aggregate Root `Wallet`, Value Object `Money` (`decimal.js`), máquina de estados de `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage` e contratos de `IntegrationEvent`.
  * `src/application`: Casos de uso transacionais (`CreateWalletUseCase`, `SubmitWagerTransactionUseCase`, `ReconcileWalletUseCase`, `WageringQueriesUseCase`) e portas de extensão (`ProviderIdentityPort`).
  * `src/infrastructure`: Persistência PostgreSQL (`MikroORM` + `Knex` explícito para controle de locks), consumidor SQS com deduplicação persistente (`Inbox`), `OutboxPublisherWorker` e `PendingReferenceWorker`.
  * `src/presentation`: API HTTP REST semântica, `GlobalDomainExceptionFilter` e `ProviderAuthGuard`.
* **Precisão Monetária Estrita**: Representação em memória com `decimal.js` (escala fixa de 2 casas decimais) e persistência em `NUMERIC(18, 2)` com moeda ISO-4217 (`CHAR(3)`). Zero uso de ponto flutuante binário (`Number` aritmético).
* **Imutabilidade Física no PostgreSQL**:
  * Trigger `trg_prevent_ledger_mutation` no banco de dados que bloqueia qualquer `UPDATE` ou `DELETE` na tabela `wallet_ledger_entries`.
  * Constraint `CHECK (balance_amount >= 0.00)` impedindo saldo negativo a nível de banco.
  * Índice único parcial `uq_wager_tx_single_processed_reversal` impedindo fisicamente que uma transação receba mais de uma reversão com status `PROCESSED`.
* **Controle de Concorrência em *Hot Wallets***:
  * Serialização por carteira via `SELECT ... FOR UPDATE` sobre a linha de `wallets`, permitindo que carteiras distintas processem em total paralelismo enquanto operações concorrentes na mesma carteira são enfileiradas de forma determinística.
  * Tratamento de corridas de idempotência via `SAVEPOINT sp_insert_wager_tx` sem abortar a transação externa.
  * Workers distribuídos (`OutboxPublisherWorker` e `PendingReferenceWorker`) utilizando `FOR UPDATE SKIP LOCKED` para escalabilidade horizontal sem conflitos entre instâncias.

> Para detalhes aprofundados sobre decisões de arquitetura, *trade-offs*, modelagem de banco e desenho de autenticação OIDC (Keycloak/Zitadel), consulte o arquivo [**`ARCHITECTURE.md`**](./ARCHITECTURE.md).

---

## 2. Como Executar o Projeto

### Pré-requisitos
* **Bun** >= 1.1
* **Docker** & **Docker Compose**

### Passo a Passo
1. **Instalar dependências**: `bun install`
2. **Subir infraestrutura (PostgreSQL 16 + LocalStack SQS)**: `docker compose up -d`
3. **Aplicar migrations (opcional, aplicadas automaticamente no boot)**: `bun run migration:up`
4. **Iniciar a aplicação**: `bun run start:dev`

---

## 3. Executando os Testes e Validações

| Comando | Descrição |
| :--- | :--- |
| `bun test` | Executa toda a suíte: Unidade, Integração (PostgreSQL + SQS + DLQ + Triggers SQL) e os **8 Cenários Obrigatórios de Concorrência**. |
| `bun run test:unit` | Executa apenas os testes unitários da camada de domínio pura. |
| `bun run test:integration` | Executa os testes de integração fim a fim (HTTP, SQL Constraints, SQS, Inbox/Outbox). |
| `bun run test:concurrency` | Executa os cenários de concorrência distribuída com **3 instâncias simultâneas** da aplicação. |
| `bun run test:load` | Executa o benchmark de carga e reconciliação em *hot wallets*. |
| `bun run typecheck` | Valida a tipagem estrita em todo o projeto (`tsc --noEmit`). |

---

## 4. Experimento de Carga e Concorrência (`bun run test:load`)

### Ambiente & Metodologia
* **Ambiente**: Execução local sobre Windows 11, runtime **Bun 1.x**, banco de dados **PostgreSQL 16-alpine** em container Docker e **LocalStack SQS**. Pool de conexões configurado com máximo de 25 conexões.
* **Metodologia**: O experimento cria **10 carteiras ativas (*hot wallets*)** com saldo inicial de `1000.00 BRL` cada e dispara **300 transações simultâneas** (`Promise.all` de 30 operações concorrentes por carteira, intercalando `BET` e `WIN` de `10.00 BRL`). Ao término da rajada, o script executa o endpoint `POST /wallets/:walletId/reconciliation` em todas as 10 carteiras e coleta as métricas Prometheus (`/metrics`) para aferir conflitos e *outbox lag*.

### Resultados Obtidos

| Métrica | Resultado Obtido | Análise Técnica |
| :--- | :--- | :--- |
| **Total Requests** | `300` | 10 carteiras x 30 transações simultâneas por carteira |
| **Concurrency** | `10 active hot wallets` | Contenção intencional por carteira |
| **Total Duration** | `4.75s` | Tempo total para drenar todas as 300 transações ACID |
| **Throughput (RPS)** | `63.16 req/s` | Limitado pelo fsync do PostgreSQL e serialização por wallet |
| **Latency p50** | `2613.97 ms` | Reflexo do enfileiramento serial (`FOR UPDATE`) de 30 reqs simultâneas na mesma carteira |
| **Latency p95** | `4383.24 ms` | Cauda da fila de lock pessimista das últimas transações da rajada |
| **Latency p99** | `4703.58 ms` | Nenhuma transação sofreu timeout ou aborto |
| **Taxa de Erro** | `0%` (`300 OK / 0 Errors`) | Zero falhas 5xx ou deadlocks |
| **Conflitos de Concorrência** | `0 abortos` | Serializados preventivamente via lock pessimista `SELECT ... FOR UPDATE` por `walletId` |
| **Outbox Lag** | `< 0.25s` | Drenado continuamente em lotes via `FOR UPDATE SKIP LOCKED` |
| **Ledger Invariant** | `✅ 100% CONSISTENT` | `storedBalance == calculatedBalance` em todas as 10 carteiras (310 entries verificadas) |

---

## 5. Endpoints Principais

* `POST /wallets` — Criação de carteira com saldo inicial e lançamento de abertura (`OPENING`).
* `GET /wallets/:walletId` — Consulta de saldo atual e versão da carteira.
* `GET /wallets/:walletId/ledger?cursor=...&limit=50` — Histórico imutável paginado por cursor.
* `POST /wallets/:walletId/reconciliation` — Reconciliação contábil (`storedBalance` vs `calculatedBalance`).
* `POST /wagering/transactions` — Processamento idempotente de `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` (requer header `Idempotency-Key`).
* `GET /wagering/transactions/:transactionId` — Consulta de transação por ID interno.
* `GET /providers/:providerId/wagering/transactions/:externalTransactionId` — Consulta por ID externo do provedor.
* `GET /health/live` & `GET /health/ready` — Probes de *liveness* e *readiness* (valida conectividade com PostgreSQL e SQS).
* `GET /metrics` — Métricas no formato Prometheus.