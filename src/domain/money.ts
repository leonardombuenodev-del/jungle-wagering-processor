import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./errors/domain.errors";

export interface MoneyProps {
  amount: string;
  currency: string;
}

const ISO_CURRENCY_REGEX = /^[A-Z]{3}$/;
const STRICT_NON_NEGATIVE_DECIMAL_2_REGEX = /^\d+\.\d{2}$/;
const STRICT_SIGNED_DECIMAL_2_REGEX = /^-?\d+\.\d{2}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== "string" || typeof props.currency !== "string") {
      throw new InvalidMoneyError("Money amount and currency must be strings");
    }

    if (!ISO_CURRENCY_REGEX.test(props.currency)) {
      throw new InvalidMoneyError(`Invalid ISO-4217 currency code: '${props.currency}'`);
    }

    if (!STRICT_NON_NEGATIVE_DECIMAL_2_REGEX.test(props.amount)) {
      throw new InvalidMoneyError(
        `Invalid money amount '${props.amount}': must be a non-negative decimal string with exact scale of 2 (e.g. '25.00')`,
      );
    }

    const decimalValue = new Decimal(props.amount);
    if (!decimalValue.isFinite()) {
      throw new InvalidMoneyError(`Money amount must be finite: '${props.amount}'`);
    }

    return new Money(decimalValue, props.currency);
  }

  static rehydrate(props: MoneyProps): Money {
    if (!props || typeof props.amount !== "string" || typeof props.currency !== "string") {
      throw new InvalidMoneyError("Money amount and currency must be strings");
    }
    if (!ISO_CURRENCY_REGEX.test(props.currency)) {
      throw new InvalidMoneyError(`Invalid ISO-4217 currency code: '${props.currency}'`);
    }
    if (!STRICT_SIGNED_DECIMAL_2_REGEX.test(props.amount)) {
      throw new InvalidMoneyError(`Invalid persisted money amount '${props.amount}'`);
    }
    return new Money(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    if (!ISO_CURRENCY_REGEX.test(currency)) {
      throw new InvalidMoneyError(`Invalid ISO-4217 currency code: '${currency}'`);
    }
    return new Money(new Decimal("0.00"), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    if (this.value.isZero()) {
      return new Money(new Decimal("0.00"), this.currency);
    }
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    if (this.currency !== other.currency) {
      return false;
    }
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
