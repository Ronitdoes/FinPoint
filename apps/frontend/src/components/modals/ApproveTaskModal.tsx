"use client";

import React, { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Textarea } from "../ui/Input";
import { CheckCircle2 } from "lucide-react";
import type { HumanTask } from "../../lib/types";

export interface ApproveTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  task: HumanTask | null;
  onConfirm: (notes?: string) => Promise<void>;
}

export function ApproveTaskModal({
  isOpen,
  onClose,
  task,
  onConfirm,
}: ApproveTaskModalProps) {
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);

  const handleApprove = async () => {
    try {
      setLoading(true);
      await onConfirm(notes ? notes : undefined);
      setNotes("");
      onClose();
    } catch {
      // Handled by parent
    } finally {
      setLoading(false);
    }
  };

  if (!task) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Approve Escalation Task"
      description={`Task ID: ${task.id} • Trigger: ${task.reason}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="success"
            loading={loading}
            icon={<CheckCircle2 className="h-3.5 w-3.5" />}
            onClick={handleApprove}
          >
            Confirm Approval
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-xs">
        <div className="rounded-xl border border-emerald-500/25 bg-emerald-950/20 p-3 text-xs text-emerald-300">
          Approving this task will unblock the autonomous recovery workflow to execute the pending intervention.
        </div>

        <Textarea
          label="Approval Notes (Optional)"
          placeholder="Add any contextual operator notes for the compliance audit trail..."
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
    </Modal>
  );
}
