import { DomainError } from "../../domain/errors/domain.errors";
import { FailureCode } from "../../domain/failure-code";
import { MoneyProps } from "../../domain/money";

export class EntityNotFoundError extends DomainError {
  readonly code = "ENTITY_NOT_FOUND";
  constructor(entity: string, id: string) {
    super(`${entity} '${id}' not found`);
  }
}

export class BusinessRejectionError extends DomainError {
  readonly code = "BUSINESS_REJECTION";
  constructor(
    public readonly transactionId: string,
    public readonly failureCode: FailureCode,
    public readonly balance: MoneyProps | undefined,
    public readonly idempotentReplay: boolean = false,
  ) {
    super(`Transaction ${transactionId} rejected with failureCode ${failureCode}`);
  }
}
