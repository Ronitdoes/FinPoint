"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP);

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";
}

export function Modal({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  maxWidth = "md",
}: ModalProps) {
  const [mounted, setMounted] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalBoxRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) {
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.body.style.overflow = "unset";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  useGSAP(
    () => {
      if (isOpen && modalBoxRef.current && overlayRef.current) {
        gsap.fromTo(
          overlayRef.current,
          { opacity: 0 },
          { opacity: 1, duration: 0.2, ease: "power2.out" }
        );
        gsap.fromTo(
          modalBoxRef.current,
          { opacity: 0, scale: 0.96, y: 10 },
          {
            opacity: 1,
            scale: 1,
            y: 0,
            duration: 0.25,
            ease: "power3.out",
            clearProps: "transform",
          }
        );
      }
    },
    { dependencies: [isOpen, mounted], scope: containerRef }
  );

  if (!isOpen || !mounted || typeof document === "undefined") return null;

  const maxWidthClasses: Record<string, string> = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
    xl: "max-w-2xl",
    "2xl": "max-w-3xl",
    "3xl": "max-w-4xl",
  };

  const modalNode = (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      onClick={(e) => {
        if (e.target === containerRef.current) {
          onClose();
        }
      }}
    >
      <div
        ref={overlayRef}
        className="fixed inset-0 bg-black/80 backdrop-blur-md"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={modalBoxRef}
        onClick={(e) => e.stopPropagation()}
        className={`relative z-10 flex max-h-[min(90vh,calc(100vh-3.5rem))] w-full ${
          maxWidthClasses[maxWidth] || maxWidthClasses.md
        } flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#131316] shadow-[0_40px_100px_-24px_rgba(0,0,0,0.95)]`}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent z-20"
        />

        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-white/[0.07] px-6 py-4.5">
          <div className="min-w-0 flex-1">
            <h2
              id="modal-title"
              className="text-[15px] font-semibold text-white tracking-tight"
            >
              {title}
            </h2>
            {description && (
              <p className="mt-1 text-xs text-white/45 font-normal leading-relaxed">{description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/[0.12] text-white/60 transition-colors hover:border-white/25 hover:text-white cursor-pointer"
            aria-label="Close modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 text-xs text-white/75 leading-relaxed overscroll-contain">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2.5 border-t border-white/[0.07] px-6 py-4 bg-[#131316]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modalNode, document.body);
}
