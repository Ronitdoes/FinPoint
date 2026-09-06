"use client";

import React, { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input, Textarea } from "../ui/Input";
import { Select } from "../ui/Select";
import { ShieldPlus } from "lucide-react";
import { api } from "../../lib/api";

export interface CreatePolicyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function CreatePolicyModal({
  isOpen,
  onClose,
  onSuccess,
}: CreatePolicyModalProps) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [ruleKind, setRuleKind] = useState("REJECT");
  const [parametersJson, setParametersJson] = useState('{\n  "max_attempts": 3\n}');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) {
      setError("Policy code is required (e.g. CUSTOM-MAX-RETRY)");
      return;
    }
    if (!name) {
      setError("Policy name is required");
      return;
    }

    let parsedParams: Record<string, unknown> = {};
    try {
      parsedParams = JSON.parse(parametersJson);
    } catch {
      setError("Parameters must be valid JSON");
      return;
    }

    try {
      setLoading(true);
      setError("");
      await api.policies.create({
        code: code.trim(),
        name,
        description: description || undefined,
        ruleKind,
        definition: parsedParams,
        enabled: true,
      });

      setCode("");
      setName("");
      setDescription("");
      onSuccess();
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create policy rule";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Create Policy Rule"
      description="Define guardrail boundaries for autonomous revenue recovery actions."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={loading}
            icon={<ShieldPlus className="h-3.5 w-3.5" />}
            onClick={handleSubmit}
          >
            Create Rule
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4 text-xs">
        {error && (
          <div className="rounded-xl bg-rose-500/10 border border-rose-500/25 p-2.5 text-xs text-rose-300">
            {error}
          </div>
        )}

        <Input
          label="Rule Code (unique)"
          placeholder="e.g. CUSTOM-MAX-RETRY"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />

        <Input
          label="Rule Name"
          placeholder="e.g. Max Payment Retries Guardrail"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />

        <div className="grid grid-cols-1 gap-3">
          <Select
            label="Rule Kind (backend enforcement)"
            value={ruleKind}
            onChange={(e) => setRuleKind(e.target.value)}
            options={[
              { value: "REJECT", label: "REJECT — block violating actions" },
              { value: "REQUIRE_APPROVAL", label: "REQUIRE_APPROVAL — route to human" },
              { value: "LIMIT", label: "LIMIT — cap spending / discounts" },
            ]}
          />
        </div>

        <Textarea
          label="Description"
          placeholder="Purpose and business context of this policy rule..."
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1.5">
            Rule Parameters (JSON)
          </label>
          <textarea
            className="w-full rounded-xl border border-white/[0.08] bg-[#090c13] p-3 font-mono text-xs text-cyan-300 focus:border-emerald-500/50 focus:outline-none"
            rows={4}
            value={parametersJson}
            onChange={(e) => setParametersJson(e.target.value)}
          />
        </div>
      </form>
    </Modal>
  );
}
