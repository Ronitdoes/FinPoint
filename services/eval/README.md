# AI Decision Quality Evaluation Harness (`services/eval`)

The evaluation harness replays labeled golden recovery datasets (`golden-v1.json`) across prompt versions without executing financial actions or side-effects (`purpose: "EVAL"`).

## Features

1. **Safety and Compliance Gate**: Asserts that `must_not_actions` (e.g. `OFFER_INCENTIVE` on payment failures) are never proposed.
2. **Schema & Semantic Validity**: Asserts structured JSON adherence to `DecisionRecordSchema` and surface-specific action bounds.
3. **Drift & Cost Accounting**: Tracks action distribution shifts, average latency, and estimated LLM token costs across prompt iterations.
4. **CI Integration**: Fails with exit code 1 if schema validity < 95% or if any `must_not` violation occurs.

## Usage

```bash
# Run evaluation with deterministic mock simulation on golden-v1 dataset
bun src/run.ts

# Run evaluation specifying a prompt version and output file
bun src/run.ts --dataset src/datasets/golden-v1.json --prompt-version payment_failure@2 --out eval-report.md
```

## Prompt Change Workflow & PR Checklist

1. **Edit Prompt**: Modify prompt template in `apps/backend/src/modules/ai/prompts/`.
2. **Bump Version**: Increment prompt version string (e.g. `@1` $\rightarrow$ `@2`).
3. **Run Evaluation**: Execute `bun services/eval/src/run.ts --out report.md`.
4. **Inspect Metrics**: Confirm:
   - Schema validity $\ge$ 95%
   - Must-not violations = 0
   - Cost delta within budget
5. **Attach Report**: Include `report.md` in the PR description before merging.
