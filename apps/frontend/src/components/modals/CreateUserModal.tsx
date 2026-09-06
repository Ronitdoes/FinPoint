"use client";

import React, { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { UserPlus } from "lucide-react";
import type { UserRole } from "../../lib/types";

export interface CreateUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (user: { email: string; role: UserRole; name: string; password: string }) => Promise<void>;
}

export function CreateUserModal({
  isOpen,
  onClose,
  onSuccess,
}: CreateUserModalProps) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<UserRole>("OPERATIONS");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      setError("Email is required");
      return;
    }
    if (!name.trim()) {
      setError("Full name is required");
      return;
    }
    if (!password || password.length < 8) {
      setError("Initial password must be at least 8 characters");
      return;
    }

    try {
      setLoading(true);
      setError("");
      await onSuccess({ email, role, name: name.trim(), password });
      setEmail("");
      setName("");
      setPassword("");
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to provision user";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Provision Operator User"
      description="Add a team member with specific role-based permissions."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={loading}
            icon={<UserPlus className="h-3.5 w-3.5" />}
            onClick={handleSubmit}
          >
            Provision User
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
          label="Full Name"
          placeholder="e.g. Maya Lin"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <Input
          label="Email Address"
          type="email"
          placeholder="e.g. maya@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <Select
          label="Assign Role"
          value={role}
          onChange={(e) => setRole(e.target.value as UserRole)}
          options={[
            { value: "VIEWER", label: "Viewer (Read-only observation)" },
            { value: "SUPPORT", label: "Support (Escalate cases)" },
            { value: "OPERATIONS", label: "Operations (Pause, resume, approve tasks)" },
            { value: "FINANCE", label: "Finance (Manage policies, stop cases, view costs)" },
            { value: "ADMIN", label: "Admin (Full control plane access)" },
          ]}
        />

        <Input
          label="Initial Temporary Password"
          type="password"
          placeholder="Minimum 8 characters"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          helperText="Share securely — user can update it after first login."
          required
        />
      </form>
    </Modal>
  );
}
