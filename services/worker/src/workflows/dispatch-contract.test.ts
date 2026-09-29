import { describe, expect, it } from "vitest";

// Namespace import on purpose: the Temporal SDK consumes the workflow bundle
// as a module namespace keyed by export name, and the bundle's internal
// modules form import cycles (e.g. invoice-overdue <-> promise-to-pay) that
// make named imports through `export *` fragile under the test transform.
// This asserts exactly what the worker registers.
import * as bundle from "./index";

/**
 * The backend dispatches PascalCase contract names (pipeline.service.ts,
 * @repo/orchestration types) while workflow functions are camelCase. The
 * PascalCase aliases live beside each workflow (same convention in every
 * workflow file). This test pins them on the bundle surface so a missing
 * alias fails loudly instead of parking live workflows in endless
 * "Workflow Task Failed" retries ("no such function is exported by the
 * workflow bundle").
 */
describe("workflow bundle dispatch-contract aliases", () => {
  const dispatched: Record<string, string> = {
    FailedPaymentRecoveryWorkflow: "failedPaymentRecoveryWorkflow",
    CheckoutRecoveryWorkflow: "checkoutAbandonmentWorkflow",
    InvoiceRecoveryWorkflow: "invoiceOverdueWorkflow",
    OverdueInvoiceWorkflow: "invoiceOverdueWorkflow",
    PromiseToPayWorkflow: "promiseToPayWorkflow",
  };

  it("exports every backend-dispatched PascalCase name", () => {
    for (const name of Object.keys(dispatched)) {
      expect(typeof (bundle as Record<string, unknown>)[name], name).toBe(
        "function",
      );
    }
  });

  it("each alias is identical to its workflow function", () => {
    for (const [alias, target] of Object.entries(dispatched)) {
      expect(
        (bundle as Record<string, unknown>)[alias],
        alias,
      ).toBe((bundle as Record<string, unknown>)[target]);
    }
  });
});
