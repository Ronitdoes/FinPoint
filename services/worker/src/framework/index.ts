declare global {
  interface BigInt {
    toJSON(): string;
  }
}

// Enable native BigInt JSON serialization across Temporal activity and workflow boundary
if (typeof BigInt !== "undefined" && !BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function (this: bigint) {
    return this.toString();
  };
}

export * from "./errors";
export * from "./retry-policies";
export * from "./activity-context";
