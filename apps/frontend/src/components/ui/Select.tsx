"use client";

import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: SelectOption[];
  error?: string;
  helperText?: string;
}

/**
 * Design-language dropdown (FinPoint `design-frontend.md`).
 *
 * Custom listbox instead of the native `<select>`: the OS-rendered menu
 * ignores the visual contract (blue highlight, mismatched borders). Props
 * stay identical to the old native wrapper — every call site keeps working
 * untouched; `onChange` receives a synthetic event carrying `target.value`
 * (and `target.name`) exactly like a native change event.
 *
 * Surfaces are solid `#131316` with hairline borders and one deep shadow;
 * motion is transform/opacity only.
 */
export function Select({
  label,
  options,
  error,
  helperText,
  className = "",
  id,
  name,
  value,
  defaultValue,
  onChange,
  onBlur,
  disabled,
  required,
  autoFocus,
  ...props
}: SelectProps) {
  // `multiple` has no button equivalent — accepted for prop compatibility,
  // stripped before spreading onto the trigger.
  const triggerProps = { ...props };
  delete (triggerProps as Record<string, unknown>).multiple;
  delete (triggerProps as Record<string, unknown>).onClick;
  delete (triggerProps as Record<string, unknown>).onKeyDown;
  const selectId =
    id || (label ? label.toLowerCase().replace(/\s+/g, "-") : undefined);
  const labelId = selectId ? `${selectId}-label` : undefined;
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);

  const isControlled = value !== undefined;
  const [internalValue, setInternalValue] = useState<string>(
    defaultValue !== undefined ? String(defaultValue) : (options[0]?.value ?? "")
  );
  const currentValue = isControlled ? String(value) : internalValue;

  const [open, setOpen] = useState(false);
  const [entered, setEntered] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);

  const selectedIndex = options.findIndex((o) => o.value === currentValue);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  // Mounted-state entrance: opacity/translate only, no layout animation.
  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => setEntered(true))
    );
    return () => cancelAnimationFrame(frame);
  }, [open ]);

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  // Outside pointer closes the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (
        target &&
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  // Keep the keyboard-active option visible.
  useEffect(() => {
    if (open && activeIndex >= 0) {
      optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open, activeIndex]);

  const commit = useCallback(
    (nextValue: string) => {
      if (!isControlled) setInternalValue(nextValue);
      if (onChange) {
        // Synthetic native-like change event: call sites only read
        // `event.target.value` (and occasionally `target.name`).
        const synthetic = {
          type: "change",
          target: { value: nextValue, name: name ?? "" },
          currentTarget: { value: nextValue, name: name ?? "" },
          preventDefault: () => {},
          stopPropagation: () => {},
          persist: () => {},
        } as unknown as React.ChangeEvent<HTMLSelectElement>;
        onChange(synthetic);
      }
      close();
      triggerRef.current?.focus();
    },
    [close, isControlled, name, onChange]
  );

  const openMenu = useCallback(
    (index?: number) => {
      if (disabled) return;
      setOpen(true);
      setActiveIndex(
        index !== undefined
          ? index
          : selectedIndex >= 0
            ? selectedIndex
            : 0
      );
    },
    [disabled, selectedIndex]
  );

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        if (!open) {
          openMenu();
        } else {
          const dir = e.key === "ArrowDown" ? 1 : -1;
          setActiveIndex((prev) => {
            const base = prev >= 0 ? prev : (selectedIndex >= 0 ? selectedIndex : 0);
            return (base + dir + options.length) % options.length;
          });
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (open && activeIndex >= 0 && options[activeIndex]) {
          commit(options[activeIndex].value);
        } else {
          openMenu();
        }
        break;
      case "Escape":
        if (open) {
          e.preventDefault();
          close();
        }
        break;
      case "Home":
        if (open) {
          e.preventDefault();
          setActiveIndex(0);
        }
        break;
      case "End":
        if (open) {
          e.preventDefault();
          setActiveIndex(options.length - 1);
        }
        break;
      case "Tab":
        if (open) close();
        break;
    }
  };

  const handleOptionKeyDown = (e: React.KeyboardEvent, index: number) => {
    // Options are focus-managed through the trigger; clicks select.
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commit(options[index].value);
    }
  };

  return (
    <div className="w-full space-y-1.5">
      {label && (
        <label
          id={labelId}
          htmlFor={selectId}
          className="block text-[11px] font-medium tracking-tight text-white/60"
        >
          {label}
          {required && <span className="ml-0.5 text-rose-400">*</span>}
        </label>
      )}
      <div className="relative">
        <button
          ref={triggerRef}
          id={selectId}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-labelledby={labelId}
          aria-activedescendant={
            open && activeIndex >= 0
              ? `${listboxId}-opt-${activeIndex}`
              : undefined
          }
          aria-invalid={!!error}
          disabled={disabled}
          autoFocus={autoFocus}
          onClick={(e) => {
            // Toggle behavior first; call-site onClick (if any) runs after.
            if (open) close();
            else openMenu();
            const userOnClick = (props as { onClick?: unknown }).onClick as
              | ((ev: React.MouseEvent<HTMLButtonElement>) => void)
              | undefined;
            userOnClick?.(e);
          }}
          onKeyDown={handleTriggerKeyDown}
          onBlur={(e) => {
            const userOnBlur = onBlur as unknown as
              | ((ev: React.FocusEvent<HTMLButtonElement>) => void)
              | undefined;
            userOnBlur?.(e);
          }}
          className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl border border-white/10 bg-[#131316] py-2 pl-3.5 pr-3 text-left text-xs text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)] transition-[border-color,background-color,box-shadow] hover:border-white/20 hover:bg-[#17171b] focus-visible:border-[#3ef0a8]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3ef0a8]/15 disabled:cursor-not-allowed disabled:opacity-50 ${
            error ? "border-rose-500/60 focus-visible:border-rose-500 focus-visible:ring-rose-500/20" : ""
          } ${className}`}
          {...(triggerProps as Record<string, unknown>)}
        >
          <span className="truncate">
            {selected ? (
              selected.label
            ) : (
              <span className="text-white/30">Select…</span>
            )}
          </span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-white/40 transition-transform duration-150 ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>

        {name && <input type="hidden" name={name} value={currentValue} />}

        {open && (
          <ul
            ref={menuRef}
            id={listboxId}
            role="listbox"
            aria-labelledby={selectId}
            className={`absolute z-30 mt-2 max-h-60 w-full overflow-auto rounded-2xl border border-white/10 bg-[#131316] p-1.5 shadow-[0_40px_100px_-24px_rgba(0,0,0,0.9)] transition-[opacity,transform] duration-150 ease-out ${
              entered ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0"
            }`}
          >
            <span
              aria-hidden="true"
              className="pointer-events-none sticky top-0 mx-6 block h-px bg-gradient-to-r from-transparent via-white/25 to-transparent"
            />
            {options.map((opt, index) => {
              const isSelected = opt.value === currentValue;
              const isActive = index === activeIndex;
              return (
                <li
                  key={opt.value}
                  id={`${listboxId}-opt-${index}`}
                  ref={(el) => {
                    optionRefs.current[index] = el;
                  }}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => commit(opt.value)}
                  onKeyDown={(e) => handleOptionKeyDown(e, index)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`flex cursor-pointer items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs transition-colors ${
                    isActive
                      ? "bg-white/[0.07] text-white"
                      : "text-white/70"
                  }`}
                >
                  <span className="truncate">{opt.label}</span>
                  {isSelected && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-[#3ef0a8]" />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {error && (
        <p className="text-[11px] font-medium text-rose-400">{error}</p>
      )}
      {helperText && !error && (
        <p className="text-[11px] text-white/40">{helperText}</p>
      )}
    </div>
  );
}
