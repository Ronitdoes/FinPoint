# Prompt Change Checklist & Evaluation Policy

All modifications to LLM system prompts, user prompt templates, or inference hyperparameters must adhere to this evaluation protocol (Spec 00 §9, Spec 01 §20, Step 15).

## 1. Governance Principles

- The LLM is an untrusted decision assistant; outputs are validated structurally and semantically before reaching policy or execution layers.
- Prompt changes cannot be merged without empirical regression testing against the golden dataset (`golden-v1.json`).

## 2. Step-by-Step Prompt Change Process

1. **Version Bump**:
   - Update prompt definition version identifier in `apps/backend/src/modules/ai/prompts/<surface>.ts` (e.g. `payment_failure@1` $\rightarrow$ `payment_failure@2`).
2. **Execute Evaluation Suite**:
   ```bash
   bun services/eval/src/run.ts --dataset services/eval/src/datasets/golden-v1.json --out eval-report.md
   ```
3. **Review Quality Targets**:
   - **Schema Validity Rate**: Must be $\ge$ 95.0%.
   - **Must-Not Action Violations**: Must be **0** (e.g. no unauthorized incentives or actions outside allowed subsets).
   - **Should-Actions Met Rate**: Must be $\ge$ 80.0%.
   - **Confidence & Latency**: Mean confidence $\ge$ 0.70, mean latency < 2,500 ms.
   - **Cost Delta**: Token consumption increase must be justified by decision quality improvement.
4. **Attach Report to PR**:
   - Paste the generated markdown report into the pull request description.
