import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidDomainOperationError,
} from "./errors/domain.errors";
import { Money } from "./money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId?: string;
  openingLedgerEntryId?: string;
  now?: Date;
}

export interface OpenWalletResult {
  wallet: Wallet;
  openingLedgerEntry: WalletLedgerEntry | null;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementCommand {
  ledgerEntryId: string;
  transactionId: string;
  amount: Money;
  at?: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenWalletResult {
    if (!props.id || !props.playerId) {
      throw new InvalidDomainOperationError("Wallet id and playerId are required");
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidDomainOperationError("Initial wallet balance cannot be negative");
    }

    const now = props.now ?? new Date();
    const zero = Money.zero(props.initialBalance.currency);

    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );

    let openingLedgerEntry: WalletLedgerEntry | null = null;

    if (props.initialBalance.isPositive()) {
      const txId = props.openingTransactionId ?? crypto.randomUUID();
      const entryId = props.openingLedgerEntryId ?? crypto.randomUUID();

      openingLedgerEntry = WalletLedgerEntry.create({
        id: entryId,
        walletId: wallet.id,
        transactionId: txId,
        direction: LedgerDirection.Credit,
        money: props.initialBalance,
        balanceBefore: zero,
        balanceAfter: props.initialBalance,
        createdAt: now,
      });
    }

    return { wallet, openingLedgerEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(cmd: WalletMovementCommand): WalletLedgerEntry {
    this.assertSameCurrency(cmd.amount);
    if (!cmd.amount.isPositive()) {
      throw new InvalidDomainOperationError("Debit amount must be strictly positive");
    }

    if (this._balance.isLessThan(cmd.amount)) {
      throw new InsufficientFundsError(this.id, this._balance.toString(), cmd.amount.toString());
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(cmd.amount);
    const now = cmd.at ?? new Date();

    const entry = WalletLedgerEntry.create({
      id: cmd.ledgerEntryId,
      walletId: this.id,
      transactionId: cmd.transactionId,
      direction: LedgerDirection.Debit,
      money: cmd.amount,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return entry;
  }

  credit(cmd: WalletMovementCommand): WalletLedgerEntry {
    this.assertSameCurrency(cmd.amount);
    if (!cmd.amount.isPositive()) {
      throw new InvalidDomainOperationError("Credit amount must be strictly positive");
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(cmd.amount);
    const now = cmd.at ?? new Date();

    const entry = WalletLedgerEntry.create({
      id: cmd.ledgerEntryId,
      walletId: this.id,
      transactionId: cmd.transactionId,
      direction: LedgerDirection.Credit,
      money: cmd.amount,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
