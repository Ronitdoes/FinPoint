"use client";

import React, { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Textarea } from "../ui/Input";
import { AlertTriangle, Pause, Play, Octagon, ArrowUpRight } from "lucide-react";

export interface CaseActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  caseId: string;
  caseNumber: string;
  action: "PAUSE" | "RESUME" | "ESCALATE" | "STOP";
  onConfirm: (payload?: { notes?: string; reason?: string }) => Promise<void>;
}

export function CaseControlModal({
  isOpen,
  onClose,
  caseId,
  caseNumber,
  action,
  onConfirm,
}: CaseActionModalProps) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleConfirm = async () => {
    if (action === "STOP" && !input.trim()) {
      setError("A stop reason is mandatory to stop an active recovery case.");
      return;
    }

    try {
      setLoading(true);
      setError("");
      if (action === "STOP") {
        await onConfirm({ reason: input.trim() });
      } else if (action === "ESCALATE") {
        await onConfirm({ notes: input.trim() || undefined });
      } else {
        await onConfirm();
      }
      setInput("");
      onClose();
    } catch (err: any) {
      setError(err?.message || `Failed to ${action.toLowerCase()} case`);
    } finally {
      setLoading(false);
    }
  };

  const actionConfig = {
    PAUSE: {
      title: "Pause Recovery Case",
      desc: `Temporarily halt autonomous workflows for case ${caseNumber}.`,
      icon: <Pause className="h-4 w-4" />,
      btnVariant: "warning" as const,
      btnLabel: "Pause Case",
    },
    RESUME: {
      title: "Resume Recovery Case",
      desc: `Resume autonomous execution and scheduled retries for case ${caseNumber}.`,
      icon: <Play className="h-4 w-4" />,
      btnVariant: "primary" as const,
      btnLabel: "Resume Case",
    },
    ESCALATE: {
      title: "Escalate Case to Human Review",
      desc: `Create a high-priority human escalation task for case ${caseNumber}.`,
      icon: <ArrowUpRight className="h-4 w-4" />,
      btnVariant: "warning" as const,
      btnLabel: "Escalate Case",
    },
    STOP: {
      title: "Stop Recovery Case (Permanent)",
      desc: `Permanently terminate all recovery attempts and mark case ${caseNumber} as STOPPED.`,
      icon: <Octagon className="h-4 w-4" />,
      btnVariant: "danger" as const,
      btnLabel: "Stop Case Permanently",
    },
  };

  const config = actionConfig[action];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={config.title}
      description={config.desc}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={config.btnVariant}
            loading={loading}
            icon={config.icon}
            onClick={handleConfirm}
          >
            {config.btnLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {action === "STOP" && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-300 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
            <span>
              This operation stops all pending payment retries and communication workflows. A mandatory reason is recorded for compliance.
            </span>
          </div>
        )}

        {action === "STOP" ? (
          <Textarea
            label="Stop Reason (Mandatory)"
            placeholder="e.g. Customer initiated dispute / legal freeze / manual settlement agreed"
            rows={3}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (error) setError("");
            }}
            error={error}
            required
          />
        ) : action === "ESCALATE" ? (
          <Textarea
            label="Escalation Notes (Optional)"
            placeholder="Provide context on why this case is being escalated..."
            rows={3}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        ) : (
          <p className="text-xs text-slate-300">
            Are you sure you want to {action.toLowerCase()} case <strong>{caseNumber}</strong>?
          </p>
        )}
      </div>
    </Modal>
  );
}
