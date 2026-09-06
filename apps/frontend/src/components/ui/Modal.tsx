"use client";

import React, { useEffect, useRef } from "react";
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
  maxWidth?: "sm" | "md" | "lg" | "xl";
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
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalBoxRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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
          { opacity: 1, duration: 0.25, ease: "power2.out" }
        );
        gsap.fromTo(
          modalBoxRef.current,
          { opacity: 0, scale: 0.96, y: 8 },
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
    { dependencies: [isOpen], scope: containerRef }
  );

  if (!isOpen) return null;

  const maxWidthClasses = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
    xl: "max-w-2xl",
  };

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div
        ref={overlayRef}
        className="fixed inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={modalBoxRef}
        className={`relative z-10 w-full ${maxWidthClasses[maxWidth]} rounded-3xl border border-white/10 bg-[#131316] p-6 shadow-[0_40px_100px_-24px_rgba(0,0,0,0.9)]`}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent"
        />
        <div className="flex items-start justify-between gap-4 pb-4 border-b border-white/[0.07]">
          <div>
            <h2
              id="modal-title"
              className="text-[15px] font-semibold text-white tracking-tight"
            >
              {title}
            </h2>
            {description && (
              <p className="mt-1 text-xs text-white/45 font-normal">{description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.12] text-white/60 transition-colors hover:border-white/25 hover:text-white cursor-pointer"
            aria-label="Close modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="py-5 text-xs text-white/75 leading-relaxed">{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-2.5 pt-4 border-t border-white/[0.07]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
