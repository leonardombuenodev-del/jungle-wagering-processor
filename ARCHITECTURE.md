# Architecture & Engineering Decisions — Distributed Wagering Processor

## 1. Visão Arquitetural
O serviço foi projetado utilizando **Hexagonal Architecture (Ports & Adapters)** combinada com **Domain-Driven Design (DDD) Tático**:

- **`src/domain`**: Camada 100% pura e livre de dependências de framework (zero imports de NestJS ou MikroORM). Contém os Value Objects (`Money`), Aggregate Root (`Wallet`), Entidades (`WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`), `IntegrationEvent` e invariantes aritméticas.
- **`src/application`**: Casos de uso transacionais (`CreateWalletUseCase`, `SubmitWagerTransactionUseCase`, `ReconcileWalletUseCase`, `WageringQueriesUseCase`) e portas de extensão (`ProviderIdentityPort`)[cite: 1].
- **`src/infrastructure`**: Adaptadores para PostgreSQL via MikroORM, migrations SQL com constraints e triggers, cliente e consumidor AWS SQS, workers de Outbox e Pending Reference, e métricas Prometheus[cite: 1].
- **`src/presentation`**: Controllers HTTP REST, filtro semântico de exceções (`GlobalDomainExceptionFilter`) e Guards[cite: 1].

---

## 2. Escolha do ORM, Mapeamento de `Money` e Estratégia Transacional
- **ORM Adotado: MikroORM (PostgreSQL)**[cite: 1]. Escolhido pela clareza no gerenciamento de contexto transacional explícito (`EntityManager.transactional()`) e acesso direto ao query builder / locks nativos do PostgreSQL[cite: 1].
- **Representação Monetária (`Money`)**: Em memória, `Money` encapsula `decimal.js` e exige strings decimais com escala fixa de 2 casas (`^\d+\.\d{2}$`)[cite: 1]. No PostgreSQL, valores monetários são armazenados como `NUMERIC(18, 2)` acompanhados de `CHAR(3)` para a moeda ISO-4217, eliminando qualquer risco de imprecisão de ponto flutuante (IEEE 754)[cite: 1].

---

## 3. Estratégia de Concorrência por `walletId` (Seção 8)
Para impedir *lost updates* e *race conditions* em cenários de *Hot Wallet* (múltiplas instâncias disputando o saldo da mesma carteira simultaneamente), adotamos **Pessimistic Write Locking (`SELECT ... FOR UPDATE`) no registro da `Wallet`** combinado com **Optimistic Version Tracking (`version`)** e **Database Constraints**[cite: 1]:

1. **Por que Pessimistic Lock na Wallet em vez de Optimistic Lock puro?**
   Em cassinos online, rajadas de apostas na mesma carteira (ou múltiplos eventos da mesma rodada) são frequentes. Sob alta contenção, *Optimistic Locking* gera tempestades de abortos (`OptimisticLockError`) e retries caros. O `SELECT ... FOR UPDATE` na linha de `wallets WHERE id = :walletId` serializa no motor do PostgreSQL apenas as transações daquela carteira específica, mantendo carteiras distintas 100% paralelas[cite: 1].
2. **Idempotência Concorrente com `SAVEPOINT`**:
   Quando 50 requisições idênticas chegam simultaneamente em múltiplas instâncias, a primeira insere a `WagerTransaction` dentro de um `SAVEPOINT sp_insert_wager_tx`. As outras 49 recebem violação de unicidade (`23505` em `uq_wager_tx_idempotency_key`), fazem rollback apenas do savepoint, aguardam a transação vencedora finalizar e retornam o replay idempotente com `idempotentReplay: true` e o `observed_balance_after` exato[cite: 1].

---

## 4. Invariantes Aplicadas no Schema do Banco (Seção 5, Regra 9)
- `wallets`: `UNIQUE (player_id, currency)`, `CHECK (balance_amount >= 0.00)`, `CHECK (version >= 1)`[cite: 1].
- `wager_transactions`: `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`, e **Índice Único Parcial** `uq_wager_tx_single_processed_reversal ON wager_transactions(reference_transaction_id) WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')` (impede fisicamente dupla reversão no banco)[cite: 1].
- `wallet_ledger_entries`: `UNIQUE (transaction_id)`, `CHECK` validando `balance_after = balance_before +/- amount`, e **Trigger `trg_prevent_ledger_mutation`** que bloqueia qualquer `UPDATE` ou `DELETE` na tabela de ledger[cite: 1].

---

## 5. Autenticação — Ponto de Extensão e Desenho OIDC (Seção 2)
Conforme permitido pela Seção 2 para priorização de *timebox* nas invariantes financeiras, a autenticação foi abstraída através da porta `ProviderIdentityPort` e do `ProviderAuthGuard` (atualmente conectado ao `NoOpProviderIdentityAdapter`), deixando `/health/live`, `/health/ready` e `/metrics` públicos[cite: 1].

**Desenho de Produção com Keycloak / Zitadel (OIDC Client Credentials):**
1. Cada provedor de jogos recebe um `client_id` e `client_secret` no IdP (Keycloak/Zitadel) com claim customizada `provider_id`.
2. O provedor obtém um Access Token JWT assinado (RS256/ES256) via *OAuth2 Client Credentials Grant*.
3. Uma implementação `OidcJwksProviderIdentityAdapter` de `ProviderIdentityPort` valida a assinatura do JWT via JWKS endpoint com cache local, verifica `iss`, `aud`, `exp` e garante que `jwt.provider_id === body.providerId`.

---

## 6. Mensageria, Inbox, Outbox e Referências Fora de Ordem
- **Transactional Inbox & Outbox**: O registro em `inbox_messages`, a mutação em `wallets`, a inserção em `wallet_ledger_entries` e o enfileiramento em `outbox_messages` ocorrem na **mesma transação ACID**[cite: 1].
- **Publishers Concorrentes**: `OutboxPublisherWorker` e `PendingReferenceWorker` utilizam `SELECT ... FOR UPDATE SKIP LOCKED`, permitindo escalar horizontalmente múltiplas instâncias sem duplicação de trabalho[cite: 1].
- **TTL de `PENDING_REFERENCE`**: Transações de `REFUND`/`ROLLBACK` cuja aposta original ainda não chegou são salvas como `PENDING_REFERENCE` (HTTP `202 Accepted`) e reprocessadas com backoff exponencial até `maxRetries = 5`[cite: 1]. Esgotado o limite, transicionam para `REJECTED` com `failureCode = REFERENCE_TRANSACTION_EXPIRED` e publicam `WagerTransactionRejected`[cite: 1].
