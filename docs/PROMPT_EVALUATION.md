# Prompt Change Checklist & Evaluation Policy

All modifications to LLM system prompts, user prompt templates, or inference hyperparameters must adhere to this evaluation protocol (Spec 00 §9, Spec 01 §20, Step 15).

## 1. Governance Principles

- The LLM is an untrusted decision assistant; outputs are validated structurally and semantically before reaching policy or execution layers.
- Prompt changes cannot be merged without empirical regression testing against the golden dataset (`golden-v1.json`).

## 2. Step-by-Step Prompt Change Process

1. **Version Bump**:
   - Update prompt definition version identifier in `apps/backend/src/modules/ai/prompts/<surface>.ts` (e.g. `payment_failure@1` $\rightarrow$ `payment_failure@2`).
2. **Execute Evaluation Suite** (canonical: workspace script; direct path is equivalent):
    ```bash
    bun run --filter @repo/eval run:eval -- --dataset services/eval/src/datasets/golden-v1.json --out eval-report.md
    # equivalent direct invocation:
    # bun services/eval/src/run.ts --dataset services/eval/src/datasets/golden-v1.json --out eval-report.md
    ```
3. **Review Quality Targets**:
   - **Schema Validity Rate**: Must be $\ge$ 95.0%.
   - **Must-Not Action Violations**: Must be **0** (e.g. no unauthorized incentives or actions outside allowed subsets).
   - **Should-Actions Met Rate**: Must be $\ge$ 80.0%.
   - **Confidence & Latency**: Mean confidence $\ge$ 0.70, mean latency < 2,500 ms.
   - **Cost Delta**: Token consumption increase must be justified by decision quality improvement.
4. **Attach Report to PR**:
    - Paste the generated markdown report into the pull request description.

## 3. Baseline-Report Diff Support (Limitation Note)

The s-15 requirement asks for "action-distribution drift vs baseline version"
and "est. cost delta" comparisons across prompt versions. The current harness
(`services/eval/src/runner.ts`) reports per-run `action_distribution` and
`total_cost_minor_units` but does **not** yet diff the current run against a
checked-in baseline JSON (no `--baseline` flag, no drift thresholds, no
`baseline-report.json` artifact committed).

Until that diff support lands, prompt-change reviewers must compare the two
numbers manually between the attached current-run report and the previous
report on the base branch:

- **Action-distribution drift**: eyeball the "Action Distribution Drift" table
  for new/missing actions vs the base-branch run.
- **Cost delta**: compare `Total Est. Cost` (`total_cost_minor_units`) and
  justify any token-consumption increase with a quality improvement.

Regression safety net: `services/eval/src/eval.test.ts` test 3 renders a real
checked-in prompt template (`getPrompt(surface).buildUserPrompt(snapshot)`
for a golden-v1 case) through the production `validateStructural` +
`validateSemantic` validators — so template/version regressions fail CI even
though the gate itself still replays via the deterministic offline simulator.
