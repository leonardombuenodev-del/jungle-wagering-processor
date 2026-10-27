# Jungle Wagering Processor — Distributed ACID Wallet & Ledger Engine

Motor transacional distribuído para processamento de apostas (*wagering*) de alta concorrência (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`), construído com **Bun**, **TypeScript 5 (Strict Mode)**, **NestJS**, **MikroORM**, **PostgreSQL 16** e **AWS SQS (LocalStack)**.

---

## 1. Destaques Arquiteturais & Garantias Financeiras

* **Hexagonal Architecture + DDD Tático**:
  * `src/domain`: Camada 100% pura e livre de dependências de framework. Contém o Aggregate Root `Wallet`, Value Object `Money` (`decimal.js`), máquina de estados de `WagerTransaction`, `WalletLedgerEntry` e contratos de `IntegrationEvent`.
  * `src/application`: Casos de uso transacionais (`CreateWalletUseCase`, `SubmitWagerTransactionUseCase`, `ReconcileWalletUseCase`, `WageringQueriesUseCase`) e portas de extensão (`ProviderIdentityPort`).
  * `src/infrastructure`: Persistência PostgreSQL (`MikroORM` + `Knex` explícito para controle de locks), consumidor SQS com deduplicação persistente (`Inbox`), `OutboxPublisherWorker` e `PendingReferenceWorker`.
  * `src/presentation`: API HTTP REST semântica, `GlobalDomainExceptionFilter` e `ProviderAuthGuard`.
* **Precisão Monetária Estrita**: Representação em memória com `decimal.js` (escala fixa de 2 casas decimais) e persistência em `NUMERIC(18, 2)` com moeda ISO-4217 (`CHAR(3)`). Zero uso de ponto flutuante binário (`Number` aritmético).
* **Imutabilidade Física no PostgreSQL**:
  * Trigger `trg_prevent_ledger_mutation` no banco de dados que bloqueia qualquer `UPDATE` ou `DELETE` na tabela `wallet_ledger_entries`.
  * Constraint `CHECK (balance_amount >= 0.00)` impedindo saldo negativo a nível de banco.
  * Índice único parcial `uq_wager_tx_single_processed_reversal` impedindo fisicamente que uma transação receba mais de um `REFUND` ou `ROLLBACK` com status `PROCESSED`.
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
1. **Instalar dependências**:
   ```bash
   bun install
   ```

2. **Subir infraestrutura (PostgreSQL 16 + LocalStack SQS)**:
   ```bash
   docker compose up -d
   ```
   *(Nota: O PostgreSQL do container é exposto na porta `5433` do host para evitar conflitos com instalações locais do PostgreSQL na porta `5432`).*

3. **Iniciar a aplicação em modo de desenvolvimento**:
   ```bash
   bun run start:dev
   ```

---

## 3. Executando os Testes e Validações

| Comando | Descrição |
| :--- | :--- |
| `bun test` | Executa toda a suíte: Testes de Unidade (Domínio), Integração (PostgreSQL + SQS + DLQ + Triggers SQL) e os **8 Cenários Obrigatórios de Concorrência**. |
| `bun run test:unit` | Executa apenas os testes unitários da camada de domínio pura. |
| `bun run test:integration` | Executa os testes de integração fim a fim (HTTP, SQL Constraints, SQS, Inbox/Outbox). |
| `bun run test:concurrency` | Executa os cenários de concorrência distribuída com **3 instâncias simultâneas** da aplicação. |
| `bun run test:load` | Executa o benchmark de carga e reconciliação em *hot wallets*. |
| `bun run typecheck` | Valida a tipagem estrita em todo o projeto (`tsc --noEmit`). |

---

## 4. Resultados do Teste de Carga e Concorrência (`bun run test:load`)

Cenário executado disparando **300 transações simultâneas** (`BET` e `WIN` intercalados) distribuídas sobre **10 *hot wallets* ativas** (30 operações concorrentes por carteira) com verificação de reconciliação contábil ao final:

| Métrica | Resultado Obtido |
| :--- | :--- |
| **Total Requests** | `300` |
| **Concurrency** | `10 active hot wallets` (30 reqs simultâneas/wallet) |
| **Total Duration** | `4.75s` |
| **Throughput (RPS)** | `63.16 req/s` |
| **Latency p50** | `2613.97 ms` (enfileiramento serial `FOR UPDATE` de 30 txs/wallet) |
| **Latency p95** | `4383.24 ms` |
| **Latency p99** | `4703.58 ms` |
| **Success / Errors** | `300 / 0` (100% sucesso) |
| **Ledger Invariant** | `✅ 100% CONSISTENT` (`wallet.balance == sum(ledger)`) |

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
* `GET /metrics` — Métricas no formato Prometheus (`wagering_transactions_total`, `wagering_processing_latency_ms`, `wagering_lock_conflicts_total`, `wagering_outbox_lag_seconds`, etc.).