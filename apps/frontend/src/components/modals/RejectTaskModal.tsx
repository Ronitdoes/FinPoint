"use client";

import React, { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Textarea } from "../ui/Input";
import { AlertOctagon } from "lucide-react";
import type { HumanTask } from "../../lib/types";

export interface RejectTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  task: HumanTask | null;
  onConfirm: (notes: string) => Promise<void>;
}

export function RejectTaskModal({
  isOpen,
  onClose,
  task,
  onConfirm,
}: RejectTaskModalProps) {
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleReject = async () => {
    if (!notes.trim()) {
      setError("Rejection reason / notes are mandatory for compliance audit records.");
      return;
    }

    try {
      setLoading(true);
      setError("");
      await onConfirm(notes.trim());
      setNotes("");
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to reject task";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  if (!task) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Reject Escalation Task"
      description={`Task ID: ${task.id} • Trigger: ${task.reason}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={loading}
            icon={<AlertOctagon className="h-3.5 w-3.5" />}
            onClick={handleReject}
          >
            Confirm Rejection
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-xs">
        <div className="rounded-xl border border-rose-500/25 bg-rose-950/20 p-3 text-xs text-rose-300">
          Rejecting this task will cancel the pending intervention and mark the task as rejected.
        </div>

        <Textarea
          label="Rejection Reason / Notes (Mandatory)"
          placeholder="Specify why this recovery intervention is being rejected..."
          rows={3}
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            if (error) setError("");
          }}
          error={error}
          required
        />
      </div>
    </Modal>
  );
}
