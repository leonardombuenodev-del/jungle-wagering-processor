import { describe, expect, it } from "bun:test";
import { computeCanonicalPayloadHash } from "../../src/domain/canonical-hash";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidDomainOperationError,
  InvalidMoneyError,
  InvalidTransactionStateError,
} from "../../src/domain/errors/domain.errors";
import { FailureCode } from "../../src/domain/failure-code";
import { Money } from "../../src/domain/money";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction";
import { Wallet } from "../../src/domain/wallet";
import { LedgerDirection } from "../../src/domain/wallet-ledger-entry";

describe("Domain Unit Tests", () => {
  describe("Money Value Object", () => {
    it("creates valid Money and preserves exact 2 decimal scale", () => {
      const m1 = Money.from({ amount: "25.00", currency: "BRL" });
      const m2 = Money.from({ amount: "10.55", currency: "BRL" });

      expect(m1.add(m2).toJSON()).toEqual({ amount: "35.55", currency: "BRL" });
      expect(m1.subtract(m2).toJSON()).toEqual({ amount: "14.45", currency: "BRL" });
      expect(m1.isPositive()).toBe(true);
      expect(Money.zero("BRL").isZero()).toBe(true);
    });

    it("rejects invalid amounts: NaN, Infinity, scientific notation, wrong scale, negative", () => {
      const invalidAmounts = [
        "",
        "NaN",
        "Infinity",
        "1e2",
        "25",
        "25.0",
        "25.000",
        "-10.00",
        "abc",
      ];

      for (const amount of invalidAmounts) {
        expect(() => Money.from({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
      }
    });

    it("throws CurrencyMismatchError when operating across currencies", () => {
      const brl = Money.from({ amount: "10.00", currency: "BRL" });
      const usd = Money.from({ amount: "10.00", currency: "USD" });

      expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    });
  });

  describe("Wallet Aggregate & Ledger Invariants", () => {
    it("opens wallet with version 1 and generates opening CREDIT ledger entry when balance > 0", () => {
      const { wallet, openingLedgerEntry } = Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      });

      expect(wallet.version).toBe(1);
      expect(wallet.balance.toString()).toBe("100.00");
      expect(openingLedgerEntry).not.toBeNull();
      expect(openingLedgerEntry?.direction).toBe(LedgerDirection.Credit);
      expect(openingLedgerEntry?.balanceBefore.toString()).toBe("0.00");
      expect(openingLedgerEntry?.balanceAfter.toString()).toBe("100.00");
      expect(openingLedgerEntry?.isBalanced()).toBe(true);
    });

    it("debits and credits updating version and generating balanced immutable ledger entries", () => {
      const { wallet } = Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      });

      const debitEntry = wallet.debit({
        ledgerEntryId: "le-1",
        transactionId: "tx-1",
        amount: Money.from({ amount: "40.00", currency: "BRL" }),
      });

      expect(wallet.balance.toString()).toBe("60.00");
      expect(wallet.version).toBe(2);
      expect(debitEntry.isBalanced()).toBe(true);

      const creditEntry = wallet.credit({
        ledgerEntryId: "le-2",
        transactionId: "tx-2",
        amount: Money.from({ amount: "15.00", currency: "BRL" }),
      });

      expect(wallet.balance.toString()).toBe("75.00");
      expect(wallet.version).toBe(3);
      expect(creditEntry.isBalanced()).toBe(true);
    });

    it("prevents negative balance on debit and throws InsufficientFundsError", () => {
      const { wallet } = Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
      });

      expect(() =>
        wallet.debit({
          ledgerEntryId: "le-1",
          transactionId: "tx-1",
          amount: Money.from({ amount: "50.01", currency: "BRL" }),
        }),
      ).toThrow(InsufficientFundsError);

      expect(wallet.balance.toString()).toBe("50.00");
      expect(wallet.version).toBe(1);
    });

    it("rejects operations with mismatched currency on wallet", () => {
      const { wallet } = Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
      });

      expect(() =>
        wallet.credit({
          ledgerEntryId: "le-1",
          transactionId: "tx-1",
          amount: Money.from({ amount: "10.00", currency: "USD" }),
        }),
      ).toThrow(CurrencyMismatchError);
    });
  });

  describe("WagerTransaction Rules & State Machine", () => {
    const baseProps = {
      id: "tx-1",
      providerId: "provider-a",
      externalTransactionId: "ext-1",
      idempotencyKey: "provider-a:ext-1",
      payloadHash: "hash-1",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      money: Money.from({ amount: "25.00", currency: "BRL" }),
    };

    it("enforces referenceExternalTransactionId for REFUND and ROLLBACK", () => {
      expect(() =>
        WagerTransaction.create({
          ...baseProps,
          kind: WagerTransactionKind.Refund,
        }),
      ).toThrow(InvalidDomainOperationError);

      expect(() =>
        WagerTransaction.create({
          ...baseProps,
          kind: WagerTransactionKind.Rollback,
        }),
      ).toThrow(InvalidDomainOperationError);
    });

    it("resolves correct ledger directions for BET, WIN, REFUND and ROLLBACK", () => {
      const bet = WagerTransaction.create({ ...baseProps, kind: WagerTransactionKind.Bet });
      const win = WagerTransaction.create({ ...baseProps, id: "tx-2", kind: WagerTransactionKind.Win });
      const loss = WagerTransaction.create({
        ...baseProps,
        id: "tx-3",
        kind: WagerTransactionKind.Loss,
        money: Money.zero("BRL"),
      });
      const refund = WagerTransaction.create({
        ...baseProps,
        id: "tx-4",
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: "ext-1",
      });
      const rollbackBet = WagerTransaction.create({
        ...baseProps,
        id: "tx-5",
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: "ext-1",
      });
      const rollbackWin = WagerTransaction.create({
        ...baseProps,
        id: "tx-6",
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: "ext-2",
      });

      expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(loss.affectsBalance()).toBe(false);
      expect(() => loss.ledgerDirectionFor()).toThrow(InvalidDomainOperationError);

      expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
      expect(rollbackBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
      expect(rollbackWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    });

    it("forbids transitioning away from terminal states (PROCESSED, REJECTED, FAILED)", () => {
      const tx = WagerTransaction.create({ ...baseProps, kind: WagerTransactionKind.Bet });
      tx.markProcessed(undefined, new Date());

      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    });

    it("detects payload hash divergence on same idempotency key", () => {
      const hashA = computeCanonicalPayloadHash({
        providerId: "provider-a",
        externalTransactionId: "ext-1",
        playerId: "player-1",
        walletId: "wallet-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
      });

      const hashB = computeCanonicalPayloadHash({
        providerId: "provider-a",
        externalTransactionId: "ext-1",
        playerId: "player-1",
        walletId: "wallet-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: "BET",
        money: { amount: "50.00", currency: "BRL" },
      });

      const tx = WagerTransaction.create({
        ...baseProps,
        payloadHash: hashA,
        kind: WagerTransactionKind.Bet,
      });

      expect(tx.matchesPayload(hashA)).toBe(true);
      expect(tx.matchesPayload(hashB)).toBe(false);
    });
  });
});
