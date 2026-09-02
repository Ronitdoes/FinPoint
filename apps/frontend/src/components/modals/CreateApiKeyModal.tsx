"use client";

import React, { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Key, Copy, Check, AlertTriangle } from "lucide-react";
import { api } from "../../lib/api";

export interface CreateApiKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function CreateApiKeyModal({
  isOpen,
  onClose,
  onSuccess,
}: CreateApiKeyModalProps) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("worker,policy:evaluate,cases:read");
  const [expiresInDays, setExpiresInDays] = useState("90");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) {
      setError("Key name is required");
      return;
    }

    try {
      setLoading(true);
      setError("");
      const scopeList = scopes.split(",").map((s) => s.trim()).filter(Boolean);
      const res = await api.admin.createApiKey({
        name,
        scopes: scopeList,
        expires_in_days: parseInt(expiresInDays, 10) || 90,
      });

      setRawKey(res.rawKey);
      onSuccess();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create API key";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (rawKey) {
      navigator.clipboard.writeText(rawKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClose = () => {
    setRawKey(null);
    setName("");
    setScopes("worker,policy:evaluate,cases:read");
    setError("");
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={rawKey ? "API Key Created" : "Issue Machine API Key"}
      description={
        rawKey
          ? "Copy your plaintext API key now. You will never be able to see it again."
          : "Create a machine credential for workers and external services."
      }
      footer={
        rawKey ? (
          <Button variant="primary" onClick={handleClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={handleClose} disabled={loading}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={loading}
              icon={<Key className="h-3.5 w-3.5" />}
              onClick={handleCreate}
            >
              Issue Key
            </Button>
          </>
        )
      }
    >
      {rawKey ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-amber-500/25 bg-amber-950/20 p-3 text-xs text-amber-300 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
            <span>
              Store this secret key securely in your environment variables. It will never be displayed again.
            </span>
          </div>

          <div className="flex items-center gap-2">
            <input
              readOnly
              value={rawKey}
              className="flex-1 rounded-xl border border-white/[0.08] bg-[#090c13] px-3.5 py-2 font-mono text-xs text-emerald-400 select-all"
            />
            <Button
              variant="secondary"
              icon={copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              onClick={handleCopy}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleCreate} className="space-y-4">
          {error && (
            <div className="rounded-xl bg-rose-500/10 border border-rose-500/25 p-2.5 text-xs text-rose-300">
              {error}
            </div>
          )}

          <Input
            label="Key Identifier / Name"
            placeholder="e.g. Temporal Worker Primary"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />

          <Input
            label="Granted Scopes (Comma-separated)"
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
            helperText="e.g. *, worker, policy:evaluate, cases:read"
          />

          <Input
            label="Expires in (Days)"
            type="number"
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
          />
        </form>
      )}
    </Modal>
  );
}
